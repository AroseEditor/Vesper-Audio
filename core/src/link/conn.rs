use super::*;

type Tls = StreamOwned<ServerConnection, TcpStream>;

pub(super) fn accept_loop(inner: Arc<Inner>, listener: TcpListener) {
    while !inner.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                let inner = inner.clone();
                thread::spawn(move || {
                    let _ = serve(inner, stream, peer);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(50)),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "timed out")
}

fn wait_frame(reader: &mut FrameReader, stream: &mut Tls, until: Instant) -> io::Result<Value> {
    loop {
        if let Some(value) = reader.poll(stream)? {
            return Ok(value);
        }
        if Instant::now() > until {
            return Err(timed_out());
        }
    }
}

fn text(value: &Value, key: &str, limit: usize) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").chars().take(limit).collect()
}

fn token_ok(inner: &Inner, given: &str) -> bool {
    let supplied = match unb64(given) {
        Some(v) if v.len() == 16 => v,
        _ => return false,
    };
    let mut guard = inner.pairing.lock().unwrap();
    match guard.as_mut() {
        Some(p) if !p.used && Instant::now() < p.expires => {
            let mut diff = 0u8;
            for (a, b) in p.token.iter().zip(supplied.iter()) {
                diff |= a ^ b;
            }
            if diff == 0 {
                p.used = true;
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

fn serve(inner: Arc<Inner>, tcp: TcpStream, peer: SocketAddr) -> io::Result<()> {
    tcp.set_nonblocking(false)?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_millis(20)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(5)))?;
    let connection = ServerConnection::new(inner.tls.clone()).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let mut stream: Tls = StreamOwned::new(connection, tcp);
    let deadline = Instant::now() + Duration::from_secs(10);
    while stream.conn.is_handshaking() {
        match stream.conn.complete_io(&mut stream.sock) {
            Ok(_) => {}
            Err(e) if is_timeout(&e) => {}
            Err(e) => return Err(e),
        }
        if Instant::now() > deadline {
            return Err(timed_out());
        }
    }
    let fp = match stream.conn.peer_certificates().and_then(|c| c.first()) {
        Some(c) => proto::sha256(c.as_ref()),
        None => return Err(io::Error::new(io::ErrorKind::PermissionDenied, "no client certificate")),
    };
    let fp_hex = hex(&fp);
    let mut reader = FrameReader::new();
    let hello = wait_frame(&mut reader, &mut stream, Instant::now() + Duration::from_secs(10))?;
    if hello.get("t").and_then(|v| v.as_str()) != Some("hello") {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "expected hello"));
    }
    let hello_id = text(&hello, "id", 64);
    if hello_id.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "missing id"));
    }
    let name = text(&hello, "name", 64);
    let model = text(&hello, "model", 64);
    let caps: Vec<String> = hello
        .get("caps")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).filter(|s| *s == "mic" || *s == "display").map(String::from).collect())
        .unwrap_or_default();
    let known = inner.store.lock().unwrap().by_fp(&fp_hex).cloned();
    let id = known.as_ref().map(|k| k.id.clone()).unwrap_or(hello_id.clone());
    let mut server_nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut server_nonce);
    write_frame(&mut stream, &json!({"t": "welcome", "v": 1, "name": inner.name, "known": known.is_some(), "nonce": b64(&server_nonce)}))?;

    let (tx, rx): (Sender<Cmd>, Receiver<Cmd>) = channel();
    let conn = inner.next_conn.fetch_add(1, Ordering::SeqCst) as u64;
    {
        let mut phones = inner.phones.lock().unwrap();
        if let Some(old) = phones.remove(&id) {
            let _ = old.tx.send(Cmd::Close);
        }
        phones.insert(
            id.clone(),
            Phone { id: id.clone(), name: name.clone(), model: model.clone(), caps, intent: "idle".into(), paired: known.is_some(), addr: peer.ip().to_string(), tx, session: None, rtt: 0, battery: -1, muted: false, conn },
        );
    }
    inner.emit_phones();
    let result = run(&inner, &mut stream, &mut reader, &rx, &id, &name, &model, &fp, &fp_hex, &server_nonce, known.is_some());
    {
        let mut phones = inner.phones.lock().unwrap();
        if phones.get(&id).map(|p| p.conn) == Some(conn) {
            if let Some(phone) = phones.remove(&id) {
                if let Some(sid) = phone.session {
                    inner.sessions.lock().unwrap().remove(&sid);
                }
            }
        }
    }
    inner.emit_phones();
    result
}

#[allow(clippy::too_many_arguments)]
fn run(inner: &Arc<Inner>, stream: &mut Tls, reader: &mut FrameReader, rx: &Receiver<Cmd>, id: &str, name: &str, model: &str, fp: &[u8; 32], fp_hex: &str, server_nonce: &[u8; 16], known: bool) -> io::Result<()> {
    if !known {
        let first = wait_frame(reader, stream, Instant::now() + Duration::from_secs(30))?;
        if first.get("t").and_then(|v| v.as_str()) != Some("pair") {
            write_frame(stream, &json!({"t": "pair.result", "ok": false, "reason": "expected pair"}))?;
            return Ok(());
        }
        if let Some(token) = first.get("token").and_then(|v| v.as_str()) {
            if !token_ok(inner, token) {
                write_frame(stream, &json!({"t": "pair.result", "ok": false, "reason": "The QR code expired or was already used. Show a new one on the PC."}))?;
                return Ok(());
            }
        } else if let Some(nonce_text) = first.get("nonce").and_then(|v| v.as_str()) {
            let client_nonce = match unb64(nonce_text) {
                Some(n) if n.len() == 16 => n,
                _ => return Ok(()),
            };
            let code = sas_code(fp, &inner.identity.fp, &client_nonce, server_nonce);
            write_frame(stream, &json!({"t": "pair.sas", "code": code}))?;
            let addr = inner.phones.lock().unwrap().get(id).map(|p| p.addr.clone()).unwrap_or_default();
            (inner.emit)("sas", json!({"id": id, "name": name, "model": model, "code": code, "addr": addr}));
            let mut pc_ok: Option<bool> = None;
            let mut phone_ok: Option<bool> = None;
            let until = Instant::now() + SAS_TIMEOUT;
            loop {
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        Cmd::Confirm(v) => pc_ok = Some(v),
                        Cmd::Close => return Ok(()),
                        Cmd::Send(m) => write_frame(stream, &m)?,
                    }
                }
                if let Some(m) = reader.poll(stream)? {
                    if m.get("t").and_then(|v| v.as_str()) == Some("pair.confirm") {
                        phone_ok = Some(m.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
                    }
                }
                if pc_ok == Some(false) || phone_ok == Some(false) || Instant::now() > until {
                    write_frame(stream, &json!({"t": "pair.result", "ok": false, "reason": "Pairing was cancelled or the codes were not confirmed."}))?;
                    return Ok(());
                }
                if pc_ok == Some(true) && phone_ok == Some(true) {
                    break;
                }
            }
        } else {
            return Ok(());
        }
        inner.store.lock().unwrap().upsert(Paired { id: id.to_string(), name: name.to_string(), model: model.to_string(), fp: fp_hex.to_string(), last_seen: now_ms() });
        if let Some(phone) = inner.phones.lock().unwrap().get_mut(id) {
            phone.paired = true;
        }
        write_frame(stream, &json!({"t": "pair.result", "ok": true}))?;
        inner.emit_phones();
    } else {
        inner.store.lock().unwrap().touch(id, now_ms());
    }

    let mut last_ping = Instant::now();
    loop {
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Send(m) => write_frame(stream, &m)?,
                Cmd::Close => return Ok(()),
                Cmd::Confirm(_) => {}
            }
        }
        if let Some(m) = reader.poll(stream)? {
            match m.get("t").and_then(|v| v.as_str()).unwrap_or("") {
                "ping" => {
                    last_ping = Instant::now();
                    let ts = m.get("ts").cloned().unwrap_or(Value::Null);
                    write_frame(stream, &json!({"t": "pong", "ts": ts, "pc": now_ms()}))?;
                }
                "intent" => {
                    let mode = text(&m, "mode", 16);
                    if mode == "mic" || mode == "display" || mode == "idle" {
                        if let Some(phone) = inner.phones.lock().unwrap().get_mut(id) {
                            phone.intent = mode;
                        }
                        inner.emit_phones();
                    }
                }
                "stats" => {
                    if let Some(phone) = inner.phones.lock().unwrap().get_mut(id) {
                        phone.rtt = m.get("rtt").and_then(|v| v.as_i64()).unwrap_or(phone.rtt);
                        phone.battery = m.get("battery").and_then(|v| v.as_i64()).unwrap_or(phone.battery);
                    }
                }
                "mute" => {
                    let on = m.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                    if let Some(phone) = inner.phones.lock().unwrap().get_mut(id) {
                        phone.muted = on;
                    }
                    inner.emit_phones();
                    (inner.emit)("mute", json!({"id": id, "on": on}));
                }
                "bye" => return Ok(()),
                _ => {}
            }
        }
        if last_ping.elapsed() > PING_TIMEOUT || inner.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
}

pub(super) fn udp_loop(inner: Arc<Inner>, socket: UdpSocket) {
    let mut buf = vec![0u8; 2048];
    while !inner.stop.load(Ordering::SeqCst) {
        let (n, src) = match socket.recv_from(&mut buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let header = match Header::parse(&buf[..n]) {
            Some(h) => h,
            None => continue,
        };
        let mut out: Vec<Value> = Vec::new();
        {
            let mut sessions = inner.sessions.lock().unwrap();
            let session = match sessions.get_mut(&header.sid) {
                Some(s) => s,
                None => continue,
            };
            let (h, plain) = match session.crypto.open(&buf[..n]) {
                Some(v) => v,
                None => continue,
            };
            session.last_rx = Instant::now();
            session.addr = Some(src);
            match h.kind {
                KIND_PUNCH | KIND_FEEDBACK => {}
                KIND_AUDIO if session.kind == KIND_AUDIO => {
                    session.rx_packets += 1;
                    for (seq, lost, frame) in session.mic.push(h.seq, plain) {
                        session.rx_lost += lost as u64;
                        out.push(json!({"id": session.phone, "sid": h.sid, "seq": seq, "lost": lost, "b64": STANDARD.encode(&frame)}));
                    }
                }
                _ => {}
            }
        }
        for value in out {
            (inner.emit)("pcm", value);
        }
    }
}
