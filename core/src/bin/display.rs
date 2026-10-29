#[cfg(windows)]
mod app {
    use std::fs::File;
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU32};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;
    use vesper_core::display::capture;
    use vesper_core::display::session::{run, Config, Stats};

    fn arg(args: &[String], key: &str) -> Option<String> {
        args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
    }

    fn serve(config: Config) {
        use std::io::{BufRead, Write};
        use std::sync::atomic::Ordering;
        let stop = Arc::new(AtomicBool::new(false));
        let keys = Arc::new(AtomicBool::new(false));
        let rate = Arc::new(AtomicU32::new(0));
        let (stop2, keys2, rate2) = (stop.clone(), keys.clone(), rate.clone());
        thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.contains("\"key\"") {
                    keys2.store(true, Ordering::SeqCst);
                } else if let Some(at) = line.find("\"kbps\":") {
                    let digits: String = line[at + 7..].chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(v) = digits.parse::<u32>() {
                        rate2.store(v, Ordering::SeqCst);
                    }
                } else if line.contains("\"stop\"") {
                    break;
                }
            }
            stop2.store(true, Ordering::SeqCst);
        });
        let mut stats = Stats::default();
        let mut out = std::io::stdout().lock();
        let result = run(&config, &stop, &keys, &rate, &mut |packet| {
            let mut header = Vec::with_capacity(5);
            header.extend_from_slice(&(packet.data.len() as u32).to_le_bytes());
            header.push(if packet.key { 1 } else { 0 });
            if out.write_all(&header).is_err() || out.write_all(&packet.data).is_err() || out.flush().is_err() {
                stop.store(true, Ordering::SeqCst);
            }
        }, &mut stats);
        if let Err(message) = result {
            eprintln!("{}", message);
            std::process::exit(1);
        }
    }

    pub fn main() {
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|a| a == "--list") {
            for (name, rect) in capture::monitors() {
                println!("{} {}x{} at {},{}", name, rect.right - rect.left, rect.bottom - rect.top, rect.left, rect.top);
            }
            return;
        }
        let config = Config {
            monitor: arg(&args, "--monitor"),
            width: arg(&args, "--width").and_then(|v| v.parse().ok()).unwrap_or(1280),
            height: arg(&args, "--height").and_then(|v| v.parse().ok()).unwrap_or(720),
            fps: arg(&args, "--fps").and_then(|v| v.parse().ok()).unwrap_or(30),
            kbps: arg(&args, "--kbps").and_then(|v| v.parse().ok()).unwrap_or(8000),
            idr_ms: arg(&args, "--idr").and_then(|v| v.parse().ok()).unwrap_or(2000),
        };
        if args.iter().any(|a| a == "--serve") {
            serve(config);
            return;
        }
        let seconds: u64 = arg(&args, "--seconds").and_then(|v| v.parse().ok()).unwrap_or(3);
        let mut file = arg(&args, "--dump").map(|p| File::create(p).expect("cannot create the dump file"));
        let stop = Arc::new(AtomicBool::new(false));
        let keys = Arc::new(AtomicBool::new(false));
        let rate = Arc::new(AtomicU32::new(0));
        let stopper = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(seconds));
            stopper.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let mut stats = Stats::default();
        let result = run(&config, &stop, &keys, &rate, &mut |packet| {
            if let Some(f) = file.as_mut() {
                let _ = f.write_all(&packet.data);
            }
        }, &mut stats);
        match result {
            Ok(()) => {
                let average = if stats.frames > 0 { stats.encode_ms_sum / stats.frames as f64 } else { 0.0 };
                println!("frames {} keys {} bytes {} capture {}x{} encode avg {:.1} ms max {:.1} ms", stats.frames, stats.keys, stats.bytes, stats.capture_width, stats.capture_height, average, stats.encode_ms_max);
            }
            Err(message) => {
                eprintln!("{}", message);
                std::process::exit(1);
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    app::main();
}

#[cfg(not(windows))]
fn main() {}
