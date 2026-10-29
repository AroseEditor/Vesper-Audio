use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use vesper_core::link::{Config, Emit, Link};

static OUT: Mutex<()> = Mutex::new(());

fn send(value: &Value) {
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", value);
    let _ = out.flush();
}

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn handle(method: &str, params: &Value, link: &mut Option<Link>, emit: &Emit) -> Result<Value, String> {
    match method {
        "core.ping" => Ok(json!({"version": env!("CARGO_PKG_VERSION")})),
        "link.start" => {
            if let Some(existing) = link.as_ref() {
                return Ok(existing.status());
            }
            let config = Config {
                data_dir: PathBuf::from(text(params, "dataDir")),
                name: text(params, "name"),
                port: params.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
            };
            let started = Link::start(config, emit.clone()).map_err(|e| e.to_string())?;
            let status = started.status();
            *link = Some(started);
            Ok(status)
        }
        "link.stop" => {
            if let Some(existing) = link.take() {
                existing.stop();
            }
            Ok(Value::Null)
        }
        _ => {
            let current = link.as_ref().ok_or("the link is not running")?;
            match method {
                "link.status" => Ok(current.status()),
                "link.pairUri" => Ok(json!({"uri": current.pair_uri()})),
                "link.phones" => Ok(current.phones()),
                "link.confirm" => Ok(json!(current.confirm(&text(params, "id"), params.get("accept").and_then(|v| v.as_bool()).unwrap_or(false)))),
                "link.forget" => {
                    current.forget(&text(params, "id"));
                    Ok(Value::Null)
                }
                "link.session.start" => current.start_session(&text(params, "id"), &text(params, "kind"), params.get("video").cloned()),
                "link.session.stop" => {
                    current.stop_session(&text(params, "id"));
                    Ok(Value::Null)
                }
                _ => Err(format!("unknown method {}", method)),
            }
        }
    }
}

fn main() {
    let emit: Emit = Arc::new(|event, data| send(&json!({"event": event, "data": data})));
    let mut link: Option<Link> = None;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap_or("").to_string();
        let outcome = handle(&method, &request["params"], &mut link, &emit);
        match outcome {
            Ok(value) => send(&json!({"id": id, "result": value})),
            Err(message) => send(&json!({"id": id, "error": message})),
        }
    }
    if let Some(existing) = link {
        existing.stop();
    }
}
