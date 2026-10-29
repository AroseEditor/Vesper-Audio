pub mod media;
pub mod proto;
pub mod store;
pub mod tls;

use base64::{engine::general_purpose::STANDARD, Engine};
use media::{Crypto, Header, MediaSession, MicRx, KIND_AUDIO, KIND_FEEDBACK, KIND_PUNCH};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use proto::{b64, hex, sas_code, unb64, write_frame, FrameReader};
use rand::RngCore;
use rustls::{ServerConnection, StreamOwned};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::{Paired, Store};
use tls::Identity;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub const DEFAULT_PORT: u16 = 47100;
const TOKEN_TTL: Duration = Duration::from_secs(120);
const PING_TIMEOUT: Duration = Duration::from_secs(6);
const SAS_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Config {
    pub data_dir: PathBuf,
    pub name: String,
    pub port: u16,
}

enum Cmd {
    Send(Value),
    Confirm(bool),
    Close,
}

struct Phone {
    id: String,
    name: String,
    model: String,
    caps: Vec<String>,
    intent: String,
    paired: bool,
    addr: String,
    tx: Sender<Cmd>,
    session: Option<u32>,
    session_kind: String,
    rtt: i64,
    battery: i64,
    muted: bool,
    conn: u64,
}

struct Pairing {
    token: [u8; 16],
    expires: Instant,
    used: bool,
}

struct Inner {
    emit: Emit,
    name: String,
    pc_id: String,
    identity: Identity,
    tls: Arc<rustls::ServerConfig>,
    store: Mutex<Store>,
    phones: Mutex<HashMap<String, Phone>>,
    pairing: Mutex<Option<Pairing>>,
    sessions: Mutex<HashMap<u32, MediaSession>>,
    port: u16,
    udp_port: u16,
    stop: AtomicBool,
    next_sid: AtomicU32,
    next_conn: AtomicU32,
    mdns: Mutex<Option<ServiceDaemon>>,
}

#[derive(Clone)]
pub struct Link {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_timeout(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

fn urlenc(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn local_ips() -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    if let Ok(list) = if_addrs::get_if_addrs() {
        for iface in list {
            if let IpAddr::V4(v4) = iface.ip() {
                if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
                    continue;
                }
                if v4.is_private() {
                    out.push(IpAddr::V4(v4));
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn sanitize_host(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "vesper-pc".to_string()
    } else {
        trimmed.to_string()
    }
}

fn advertise(name: &str, pc_id: &str, fp: &[u8; 32], port: u16) -> Option<ServiceDaemon> {
    let daemon = ServiceDaemon::new().ok()?;
    let host = format!("{}.local.", sanitize_host(name));
    let fp_short = hex(&fp[..8]);
    let props = [("v", "1"), ("id", pc_id), ("name", name), ("fp", fp_short.as_str())];
    let info = ServiceInfo::new("_vesper-link._tcp.local.", name, &host, "", port, &props[..]).ok()?.enable_addr_auto();
    daemon.register(info).ok()?;
    Some(daemon)
}

impl Link {
    pub fn start(config: Config, emit: Emit) -> io::Result<Link> {
        let dir = config.data_dir.join("link");
        let identity = tls::load_or_create(&dir, "vesper-audio")?;
        let tls_config = tls::server_config(&identity).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        let store = Store::open(&dir);
        let listener = TcpListener::bind(("0.0.0.0", if config.port == 0 { DEFAULT_PORT } else { config.port }))
            .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let udp = UdpSocket::bind(("0.0.0.0", 0))?;
        udp.set_read_timeout(Some(Duration::from_millis(250)))?;
        let udp_port = udp.local_addr()?.port();
        let pc_id = hex(&identity.fp[..6]);
        let inner = Arc::new(Inner {
            emit,
            name: config.name.clone(),
            pc_id: pc_id.clone(),
            identity: identity.clone(),
            tls: tls_config,
            store: Mutex::new(store),
            phones: Mutex::new(HashMap::new()),
            pairing: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            port,
            udp_port,
            stop: AtomicBool::new(false),
            next_sid: AtomicU32::new(1),
            next_conn: AtomicU32::new(1),
            mdns: Mutex::new(None),
        });
        *inner.mdns.lock().unwrap() = advertise(&config.name, &pc_id, &identity.fp, port);
        let accept = inner.clone();
        thread::spawn(move || accept_loop(accept, listener));
        let media = inner.clone();
        thread::spawn(move || udp_loop(media, udp));
        Ok(Link { inner })
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        if let Some(daemon) = self.inner.mdns.lock().unwrap().take() {
            let _ = daemon.shutdown();
        }
        let phones = self.inner.phones.lock().unwrap();
        for phone in phones.values() {
            let _ = phone.tx.send(Cmd::Close);
        }
    }

    pub fn port(&self) -> u16 {
        self.inner.port
    }

    pub fn udp_port(&self) -> u16 {
        self.inner.udp_port
    }

    pub fn fingerprint(&self) -> [u8; 32] {
        self.inner.identity.fp
    }

    pub fn status(&self) -> Value {
        json!({
            "running": !self.inner.stop.load(Ordering::SeqCst),
            "port": self.inner.port,
            "udp": self.inner.udp_port,
            "id": self.inner.pc_id,
            "name": self.inner.name,
            "fp": hex(&self.inner.identity.fp),
            "ips": local_ips().iter().map(|ip| ip.to_string()).collect::<Vec<_>>(),
        })
    }

    pub fn pair_uri(&self) -> String {
        let mut token = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut token);
        *self.inner.pairing.lock().unwrap() = Some(Pairing { token, expires: Instant::now() + TOKEN_TTL, used: false });
        let ips: Vec<String> = local_ips().iter().map(|ip| ip.to_string()).collect();
        format!(
            "vesper://pair?v=1&a={}&p={}&f={}&t={}&n={}",
            ips.join(","),
            self.inner.port,
            b64(&self.inner.identity.fp),
            b64(&token),
            urlenc(&self.inner.name)
        )
    }

    pub fn phones(&self) -> Value {
        self.inner.phones_json()
    }

    pub fn confirm(&self, id: &str, accept: bool) -> bool {
        match self.inner.phones.lock().unwrap().get(id) {
            Some(phone) => phone.tx.send(Cmd::Confirm(accept)).is_ok(),
            None => false,
        }
    }

    pub fn forget(&self, id: &str) {
        self.stop_session(id);
        self.inner.store.lock().unwrap().forget(id);
        if let Some(phone) = self.inner.phones.lock().unwrap().get(id) {
            let _ = phone.tx.send(Cmd::Close);
        }
        self.inner.emit_phones();
    }

    pub fn start_session(&self, id: &str, kind: &str, video: Option<Value>) -> Result<Value, String> {
        let kind_byte = match kind {
            "mic" => KIND_AUDIO,
            "display" => media::KIND_VIDEO,
            _ => return Err("unknown session kind".into()),
        };
        self.stop_session(id);
        let mut phones = self.inner.phones.lock().unwrap();
        let phone = phones.get_mut(id).ok_or("the phone is not connected")?;
        if !phone.paired {
            return Err("the phone is not paired".into());
        }
        if !phone.caps.iter().any(|c| c == kind) {
            return Err(format!("the phone does not support {}", kind));
        }
        let sid = self.inner.next_sid.fetch_add(1, Ordering::SeqCst);
        let mut key = [0u8; 16];
        let mut salt = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut key);
        rand::thread_rng().fill_bytes(&mut salt);
        let crypto = Crypto::new(&key, salt).ok_or("could not create the session key")?;
        self.inner.sessions.lock().unwrap().insert(
            sid,
            MediaSession { phone: id.to_string(), kind: kind_byte, crypto, addr: None, mic: MicRx::new(), rx_packets: 0, rx_lost: 0, last_rx: Instant::now(), tx_seq: 0 },
        );
        phone.session = Some(sid);
        phone.session_kind = kind.to_string();
        let mut message = json!({"t": "session.start", "sid": sid, "kind": kind, "udp": self.inner.udp_port, "key": b64(&key), "salt": b64(&salt), "rate": 48000, "ch": 1, "frameMs": 10, "codec": "pcm16", "redundancy": 0});
        if let Some(video) = video {
            message["video"] = video;
        }
        let _ = phone.tx.send(Cmd::Send(message));
        drop(phones);
        self.inner.emit_phones();
        Ok(json!({"sid": sid, "udp": self.inner.udp_port}))
    }

    pub fn stop_session(&self, id: &str) {
        let sid = {
            let mut phones = self.inner.phones.lock().unwrap();
            match phones.get_mut(id) {
                Some(phone) => {
                    let sid = phone.session.take();
                    phone.session_kind.clear();
                    if let Some(sid) = sid {
                        let _ = phone.tx.send(Cmd::Send(json!({"t": "session.stop", "sid": sid})));
                    }
                    sid
                }
                None => None,
            }
        };
        if let Some(sid) = sid {
            self.inner.sessions.lock().unwrap().remove(&sid);
            (self.inner.emit)("session", json!({"id": id, "sid": sid, "state": "stopped"}));
            self.inner.emit_phones();
        }
    }

    pub fn send_media(&self, sid: u32, kind: u8, flags: u8, ts: u32, plaintext: &[u8], socket: &UdpSocket) -> bool {
        let mut sessions = self.inner.sessions.lock().unwrap();
        let session = match sessions.get_mut(&sid) {
            Some(s) => s,
            None => return false,
        };
        let addr = match session.addr {
            Some(a) => a,
            None => return false,
        };
        let header = Header { kind, flags, sid, seq: session.tx_seq, ts };
        session.tx_seq = session.tx_seq.wrapping_add(1);
        let packet = session.crypto.seal(&header, plaintext);
        socket.send_to(&packet, addr).is_ok()
    }
}

fn phone_json(phone: &Phone, paired: bool) -> Value {
    json!({
        "id": phone.id,
        "name": phone.name,
        "model": phone.model,
        "caps": phone.caps,
        "intent": phone.intent,
        "online": true,
        "muted": phone.muted,
        "paired": paired && phone.paired,
        "session": phone.session,
        "sessionKind": phone.session_kind,
        "rtt": phone.rtt,
        "battery": phone.battery,
        "addr": phone.addr,
    })
}

impl Inner {
    fn phones_json(&self) -> Value {
        let store = self.store.lock().unwrap();
        let phones = self.phones.lock().unwrap();
        let mut list: Vec<Value> = Vec::new();
        for paired in &store.list {
            match phones.get(&paired.id) {
                Some(phone) => list.push(phone_json(phone, true)),
                None => list.push(json!({"id": paired.id, "name": paired.name, "model": paired.model, "caps": [], "intent": "idle", "online": false, "muted": false, "paired": true, "session": null, "sessionKind": "", "rtt": 0, "battery": -1, "addr": "", "lastSeen": paired.last_seen})),
            }
        }
        for phone in phones.values() {
            if !store.list.iter().any(|p| p.id == phone.id) {
                list.push(phone_json(phone, false));
            }
        }
        Value::Array(list)
    }

    fn emit_phones(&self) {
        (self.emit)("phones", self.phones_json());
    }
}

mod conn;
use conn::{accept_loop, udp_loop};
