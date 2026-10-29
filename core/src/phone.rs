use crate::link::media::{Crypto, Header, KIND_AUDIO, KIND_PUNCH};
use crate::link::proto::{b64, hex, sas_code, sha256, unb64, write_frame, FrameReader};
use crate::link::tls;
use rand::Rng;
use rustls::pki_types::ServerName;
use rustls::{ClientConnection, StreamOwned};
use serde_json::{json, Value};
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub struct Opts {
    pub qr: Option<String>,
    pub addr: Option<String>,
    pub dir: PathBuf,
    pub name: String,
    pub id: String,
    pub mode: String,
    pub seconds: u64,
    pub loss: f64,
    pub reorder: bool,
    pub auto_confirm: bool,
    pub confirm_delay_ms: u64,
    pub mute_after_ms: u64,
}

#[derive(Default, Debug)]
pub struct Report {
    pub paired: bool,
    pub known: bool,
    pub sas: Option<String>,
    pub session: bool,
    pub sent: u32,
    pub dropped: u32,
    pub fp: String,
    pub error: Option<String>,
}

struct Target {
    addrs: Vec<SocketAddr>,
    pin: Option<[u8; 32]>,
    token: Option<String>,
}

fn query(uri: &str) -> Vec<(String, String)> {
    let q = uri.splitn(2, '?').nth(1).unwrap_or("");
    q.split('&')
        .filter_map(|kv| {
            let mut it = kv.splitn(2, '=');
            Some((it.next()?.to_string(), it.next().unwrap_or("").to_string()))
        })
        .collect()
}

fn target(opts: &Opts) -> Result<Target, String> {
    if let Some(uri) = &opts.qr {
        let q = query(uri);
        let get = |k: &str| q.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        let port: u16 = get("p").and_then(|p| p.parse().ok()).ok_or("QR code has no port")?;
        let ips = get("a").ok_or("QR code has no address")?;
        let pin_bytes = get("f").and_then(|f| unb64(&f)).ok_or("QR code has no fingerprint")?;
        if pin_bytes.len() != 32 {
            return Err("bad fingerprint".into());
        }
        let mut pin = [0u8; 32];
        pin.copy_from_slice(&pin_bytes);
        let addrs = ips.split(',').filter_map(|ip| format!("{}:{}", ip, port).parse().ok()).collect();
        return Ok(Target { addrs, pin: Some(pin), token: get("t") });
    }
    let addr = opts.addr.clone().ok_or("pass --qr or --addr")?;
    let addrs: Vec<SocketAddr> = addr.to_socket_addrs().map_err(|e| e.to_string())?.collect();
    Ok(Target { addrs, pin: None, token: None })
}

fn connect(addrs: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no address");
    for addr in addrs {
        match TcpStream::connect_timeout(addr, Duration::from_secs(3)) {
            Ok(s) => return Ok(s),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

fn wait(reader: &mut FrameReader, stream: &mut StreamOwned<ClientConnection, TcpStream>, secs: u64) -> io::Result<Value> {
    let until = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = reader.poll(stream)? {
            return Ok(v);
        }
        if Instant::now() > until {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
        }
    }
}

fn media(host: std::net::IpAddr, params: Value, opts_loss: f64, opts_reorder: bool, muted: Arc<AtomicBool>, stop: Arc<AtomicBool>, sent: Arc<std::sync::atomic::AtomicU32>, dropped: Arc<std::sync::atomic::AtomicU32>) {
    let sid = params["sid"].as_u64().unwrap_or(0) as u32;
    let port = params["udp"].as_u64().unwrap_or(0) as u16;
    let key = unb64(params["key"].as_str().unwrap_or("")).unwrap_or_default();
    let salt_bytes = unb64(params["salt"].as_str().unwrap_or("")).unwrap_or_default();
    if salt_bytes.len() != 4 {
        return;
    }
    let salt = [salt_bytes[0], salt_bytes[1], salt_bytes[2], salt_bytes[3]];
    let crypto = match Crypto::new(&key, salt) {
        Some(c) => c,
        None => return,
    };
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return,
    };
    let dest = SocketAddr::new(host, port);
    let punch = crypto.seal(&Header { kind: KIND_PUNCH, flags: 0, sid, seq: 0, ts: 0 }, &[]);
    let _ = socket.send_to(&punch, dest);
    let mut rng = rand::thread_rng();
    let mut seq: u32 = 0;
    let mut phase = 0.0f32;
    let mut stash: Option<Vec<u8>> = None;
    let mut next = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let mut pcm = Vec::with_capacity(960);
        for _ in 0..480 {
            let v = (phase.sin() * 8000.0) as i16;
            pcm.extend_from_slice(&v.to_le_bytes());
            phase += 2.0 * std::f32::consts::PI * 440.0 / 48000.0;
        }
        let packet = crypto.seal(&Header { kind: KIND_AUDIO, flags: 0, sid, seq, ts: seq.wrapping_mul(480) }, &pcm);
        seq = seq.wrapping_add(1);
        if muted.load(Ordering::SeqCst) {
            next += Duration::from_millis(10);
            let now = Instant::now();
            if next > now {
                thread::sleep(next - now);
            }
            continue;
        }
        if rng.gen::<f64>() < opts_loss {
            dropped.fetch_add(1, Ordering::SeqCst);
        } else if opts_reorder && stash.is_none() && rng.gen::<f64>() < 0.1 {
            stash = Some(packet);
        } else {
            if socket.send_to(&packet, dest).is_ok() {
                sent.fetch_add(1, Ordering::SeqCst);
            }
            if let Some(held) = stash.take() {
                if socket.send_to(&held, dest).is_ok() {
                    sent.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        next += Duration::from_millis(10);
        let now = Instant::now();
        if next > now {
            thread::sleep(next - now);
        }
    }
}

pub fn run(opts: Opts) -> Report {
    let mut report = Report::default();
    match run_inner(&opts, &mut report) {
        Ok(()) => {}
        Err(e) => report.error = Some(e.to_string()),
    }
    report
}

fn run_inner(opts: &Opts, report: &mut Report) -> io::Result<()> {
    let target = target(opts).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let identity = tls::load_or_create(&opts.dir, "fakephone")?;
    report.fp = hex(&identity.fp);
    let config = tls::client_config(&identity, target.pin).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let tcp = connect(&target.addrs)?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_millis(20)))?;
    let host = tcp.peer_addr()?.ip();
    let name = ServerName::try_from("vesper-audio").map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let conn = ClientConnection::new(config, name).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let mut stream = StreamOwned::new(conn, tcp);
    let deadline = Instant::now() + Duration::from_secs(10);
    while stream.conn.is_handshaking() {
        match stream.conn.complete_io(&mut stream.sock) {
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(e) => return Err(e),
        }
        if Instant::now() > deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "handshake timed out"));
        }
    }
    let server_fp = stream.conn.peer_certificates().and_then(|c| c.first()).map(|c| sha256(c.as_ref())).unwrap_or([0u8; 32]);
    let mut reader = FrameReader::new();
    write_frame(&mut stream, &json!({"t": "hello", "v": 1, "id": opts.id, "name": opts.name, "model": "Fake Phone", "api": 34, "caps": ["mic", "display"], "w": 1080, "h": 2400, "rate": 60}))?;
    let welcome = wait(&mut reader, &mut stream, 10)?;
    let known = welcome["known"].as_bool().unwrap_or(false);
    report.known = known;
    let server_nonce = unb64(welcome["nonce"].as_str().unwrap_or("")).unwrap_or_default();
    if !known {
        if let Some(token) = &target.token {
            write_frame(&mut stream, &json!({"t": "pair", "token": token}))?;
        } else {
            let mut nonce = [0u8; 16];
            rand::thread_rng().fill(&mut nonce);
            write_frame(&mut stream, &json!({"t": "pair", "nonce": b64(&nonce)}))?;
            let sas = wait(&mut reader, &mut stream, 10)?;
            let code = sas["code"].as_str().unwrap_or("").to_string();
            let mine = sas_code(&identity.fp, &server_fp, &nonce, &server_nonce);
            report.sas = Some(code.clone());
            if code != mine {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "short codes differ"));
            }
            if opts.auto_confirm {
                thread::sleep(Duration::from_millis(opts.confirm_delay_ms));
                write_frame(&mut stream, &json!({"t": "pair.confirm", "ok": true}))?;
            }
        }
        let result = wait(&mut reader, &mut stream, 130)?;
        report.paired = result["ok"].as_bool().unwrap_or(false);
        if !report.paired {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, result["reason"].as_str().unwrap_or("pairing failed").to_string()));
        }
    } else {
        report.paired = true;
    }
    write_frame(&mut stream, &json!({"t": "intent", "mode": opts.mode}))?;
    let stop = Arc::new(AtomicBool::new(false));
    let sent = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let dropped = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let muted = Arc::new(AtomicBool::new(false));
    let mut worker: Option<thread::JoinHandle<()>> = None;
    let started = Instant::now();
    let mut last_ping = Instant::now() - Duration::from_secs(2);
    while started.elapsed() < Duration::from_secs(opts.seconds) {
        if last_ping.elapsed() >= Duration::from_secs(1) {
            last_ping = Instant::now();
            write_frame(&mut stream, &json!({"t": "ping", "ts": started.elapsed().as_millis() as u64}))?;
        }
        if opts.mute_after_ms > 0 && !muted.load(Ordering::SeqCst) && started.elapsed() >= Duration::from_millis(opts.mute_after_ms) {
            muted.store(true, Ordering::SeqCst);
            write_frame(&mut stream, &json!({"t": "mute", "on": true}))?;
        }
        if let Some(m) = reader.poll(&mut stream)? {
            if m["t"].as_str() == Some("session.start") && worker.is_none() {
                report.session = true;
                let (stop2, sent2, dropped2, muted2) = (stop.clone(), sent.clone(), dropped.clone(), muted.clone());
                let (loss, reorder) = (opts.loss, opts.reorder);
                worker = Some(thread::spawn(move || media(host, m, loss, reorder, muted2, stop2, sent2, dropped2)));
            }
        }
    }
    stop.store(true, Ordering::SeqCst);
    if let Some(w) = worker {
        let _ = w.join();
    }
    let _ = write_frame(&mut stream, &json!({"t": "bye"}));
    report.sent = sent.load(Ordering::SeqCst);
    report.dropped = dropped.load(Ordering::SeqCst);
    Ok(())
}
