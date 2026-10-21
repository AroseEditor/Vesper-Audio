mod audio;
mod driver;
mod gpu;

use serde_json::{json, Value};
use std::env;
use std::fs;

fn flag(args: &mut Vec<String>, name: &str) -> Option<String> {
    let at = args.iter().position(|a| a == name)?;
    args.remove(at);
    if at < args.len() { Some(args.remove(at)) } else { None }
}

fn need<'a>(args: &'a [String], i: usize) -> Result<&'a str, String> {
    args.get(i).map(|s| s.as_str()).ok_or_else(|| "missing argument".to_string())
}

fn run(args: &[String]) -> Result<Value, String> {
    audio::init()?;
    match need(args, 0)? {
        "list" => audio::list(),
        "volume" => audio::set_volume(need(args, 1)?, need(args, 2)?.parse::<f32>().map_err(|e| e.to_string())?),
        "mute" => audio::set_mute(need(args, 1)?, need(args, 2)? == "1"),
        "listen" => audio::set_listen(need(args, 1)?, need(args, 2)? == "1"),
        "sysfx" => audio::set_sysfx(need(args, 1)?, need(args, 2)? == "1"),
        "rename" => audio::rename(need(args, 1)?, need(args, 2)?, args.get(3).map(|s| s.as_str()).unwrap_or(""), args.get(4).map(|s| s.as_str()).unwrap_or("")),
        "brand" => audio::brand(args.get(1).map(|s| s.as_str()).unwrap_or("")),
        "gpus" => gpu::list(),
        "driver-status" => driver::status(),
        "driver-install" => driver::install(need(args, 1)?),
        "driver-verify" => driver::verify(need(args, 1)?),
        "driver-uninstall" => driver::uninstall(),
        other => Err(format!("unknown command {other}")),
    }
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let out = flag(&mut args, "--out");
    let result = run(&args);
    match (out, result) {
        (Some(path), Ok(v)) => {
            let _ = fs::write(path, v.to_string());
        }
        (Some(path), Err(e)) => {
            let _ = fs::write(path, json!({ "ok": false, "message": e }).to_string());
        }
        (None, Ok(v)) => println!("{v}"),
        (None, Err(e)) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
