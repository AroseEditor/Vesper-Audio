use super::media::{Header, VideoState, KIND_VIDEO};
use super::*;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

const SLICE: usize = 1100;
const RING: usize = 64;

fn display_exe() -> PathBuf {
    let name = if cfg!(windows) { "vesper-display.exe" } else { "vesper-display" };
    let own = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    let beside = own.join(name);
    if beside.exists() {
        return beside;
    }
    own.parent().map(|p| p.join(name)).unwrap_or(beside)
}

fn number(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(|v| v.as_u64()).filter(|v| *v > 0).unwrap_or(default)
}

pub(super) fn normalize(params: Option<Value>) -> Value {
    let given = params.unwrap_or_else(|| json!({}));
    json!({
        "codec": "h264",
        "w": number(&given, "w", 1280),
        "h": number(&given, "h", 720),
        "fps": number(&given, "fps", 30),
        "kbps": number(&given, "kbps", 8000),
        "idrMs": number(&given, "idrMs", 2000),
        "monitor": given.get("monitor").and_then(|v| v.as_str()).unwrap_or(""),
    })
}

pub(super) fn begin(inner: &Arc<Inner>, sid: u32, id: String, params: Value) {
    let inner = inner.clone();
    thread::spawn(move || pump(inner, sid, id, params));
}

fn fail(inner: &Inner, id: &str, sid: u32, message: &str) {
    (inner.emit)("display", json!({"id": id, "sid": sid, "state": "error", "message": message}));
}

fn pump(inner: Arc<Inner>, sid: u32, id: String, params: Value) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        match inner.sessions.lock().unwrap().get(&sid) {
            Some(s) if s.addr.is_some() => break,
            Some(_) => {}
            None => return,
        }
        if Instant::now() > until {
            fail(&inner, &id, sid, "The phone did not answer. Open the Connector app and try again.");
            inner.end_session(sid);
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let mut command = Command::new(display_exe());
    command
        .args(["--serve", "--width", &number(&params, "w", 1280).to_string(), "--height", &number(&params, "h", 720).to_string(), "--fps", &number(&params, "fps", 30).to_string(), "--kbps", &number(&params, "kbps", 8000).to_string(), "--idr", &number(&params, "idrMs", 2000).to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(monitor) = params.get("monitor").and_then(|v| v.as_str()).filter(|m| !m.is_empty()) {
        command.args(["--monitor", monitor]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            fail(&inner, &id, sid, &format!("Could not start the screen sender: {}", e));
            inner.end_session(sid);
            return;
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let stdin = child.stdin.take().unwrap();
    let kbps = number(&params, "kbps", 8000) as u32;
    {
        let mut sessions = inner.sessions.lock().unwrap();
        match sessions.get_mut(&sid) {
            Some(s) => {
                s.video = Some(VideoState { frame_id: 0, ring: VecDeque::new(), kbps, max_kbps: kbps, last_lost: 0, last_report: Instant::now(), last_raise: Instant::now(), control: Some(Arc::new(Mutex::new(stdin))), child: Some(child) });
            }
            None => {
                let _ = child.kill();
                return;
            }
        }
    }
    (inner.emit)("display", json!({"id": id, "sid": sid, "state": "started"}));
    let mut head = [0u8; 5];
    while stdout.read_exact(&mut head).is_ok() {
        let length = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        if length > 8 << 20 {
            break;
        }
        let mut data = vec![0u8; length];
        if stdout.read_exact(&mut data).is_err() {
            break;
        }
        send_frame(&inner, sid, data, head[4] & 1 == 1);
    }
    let alive = inner.sessions.lock().unwrap().contains_key(&sid);
    if alive {
        fail(&inner, &id, sid, "The screen sender stopped. Check that the screen can be captured and try again.");
        inner.end_session(sid);
    }
}

fn send_frame(inner: &Inner, sid: u32, data: Vec<u8>, key: bool) {
    let (addr, packets) = {
        let mut sessions = inner.sessions.lock().unwrap();
        let s = match sessions.get_mut(&sid) {
            Some(s) => s,
            None => return,
        };
        let addr = match s.addr {
            Some(a) => a,
            None => return,
        };
        let frame_id = match s.video.as_mut() {
            Some(v) => {
                v.frame_id = v.frame_id.wrapping_add(1);
                v.frame_id
            }
            None => return,
        };
        let count = (data.len() + SLICE - 1) / SLICE;
        let mut packets = Vec::with_capacity(count);
        for (i, chunk) in data.chunks(SLICE).enumerate() {
            let mut plain = Vec::with_capacity(8 + chunk.len());
            plain.extend_from_slice(&frame_id.to_be_bytes());
            plain.extend_from_slice(&(i as u16).to_be_bytes());
            plain.extend_from_slice(&(count as u16).to_be_bytes());
            plain.extend_from_slice(chunk);
            let flags = (if key { 1 } else { 0 }) | (if i + 1 == count { 2 } else { 0 });
            let header = Header { kind: KIND_VIDEO, flags, sid, seq: s.tx_seq, ts: (now_ms() as u32).wrapping_mul(1000) };
            s.tx_seq = s.tx_seq.wrapping_add(1);
            packets.push(s.crypto.seal(&header, &plain));
        }
        if let Some(v) = s.video.as_mut() {
            v.ring.push_back((frame_id, packets.clone()));
            while v.ring.len() > RING {
                v.ring.pop_front();
            }
        }
        (addr, packets)
    };
    let burst = packets.len() > 24;
    for (i, packet) in packets.iter().enumerate() {
        let _ = inner.udp.send_to(packet, addr);
        if burst && i % 6 == 5 {
            thread::sleep(Duration::from_micros(200));
        }
    }
}

pub(super) fn feedback(inner: &Inner, sid: u32, plain: &[u8]) {
    if plain.len() < 20 {
        return;
    }
    let lost = u32::from_be_bytes([plain[4], plain[5], plain[6], plain[7]]);
    let flags = u16::from_be_bytes([plain[18], plain[19]]);
    let mut resend: Vec<Vec<u8>> = Vec::new();
    let mut command: Option<String> = None;
    let mut control = None;
    let mut addr = None;
    {
        let mut sessions = inner.sessions.lock().unwrap();
        let s = match sessions.get_mut(&sid) {
            Some(s) => s,
            None => return,
        };
        addr = s.addr.or(addr);
        let v = match s.video.as_mut() {
            Some(v) => v,
            None => return,
        };
        control = v.control.clone();
        if flags & 1 == 1 {
            command = Some("{\"t\":\"key\"}\n".to_string());
        }
        if plain.len() >= 22 {
            let count = u16::from_be_bytes([plain[20], plain[21]]) as usize;
            for n in 0..count.min(32) {
                let at = 22 + n * 6;
                if plain.len() < at + 6 {
                    break;
                }
                let frame = u32::from_be_bytes([plain[at], plain[at + 1], plain[at + 2], plain[at + 3]]);
                let frag = u16::from_be_bytes([plain[at + 4], plain[at + 5]]) as usize;
                if let Some((_, packets)) = v.ring.iter().find(|(f, _)| *f == frame) {
                    if let Some(packet) = packets.get(frag) {
                        resend.push(packet.clone());
                    }
                }
            }
        }
        let now = Instant::now();
        if lost > v.last_lost + 2 {
            v.kbps = (v.kbps * 7 / 10).max(1500);
            v.last_raise = now;
            command = Some(format!("{{\"t\":\"bitrate\",\"kbps\":{}}}\n", v.kbps));
        } else if now.duration_since(v.last_raise) > Duration::from_secs(1) && v.kbps < v.max_kbps {
            v.kbps = (v.kbps * 105 / 100).min(v.max_kbps);
            v.last_raise = now;
            command = Some(format!("{{\"t\":\"bitrate\",\"kbps\":{}}}\n", v.kbps));
        }
        v.last_lost = lost;
        v.last_report = now;
    }
    if let Some(addr) = addr {
        for packet in resend {
            let _ = inner.udp.send_to(&packet, addr);
        }
    }
    if let (Some(text), Some(control)) = (command, control) {
        if let Ok(mut pipe) = control.lock() {
            let _ = pipe.write_all(text.as_bytes());
            let _ = pipe.flush();
        }
    }
}
