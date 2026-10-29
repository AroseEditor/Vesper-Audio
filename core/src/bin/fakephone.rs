use std::path::PathBuf;
use vesper_core::phone::{run, Opts};

fn arg(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opts = Opts {
        qr: arg(&args, "--qr"),
        addr: arg(&args, "--addr"),
        dir: PathBuf::from(arg(&args, "--dir").unwrap_or_else(|| "fakephone-data".into())),
        name: arg(&args, "--name").unwrap_or_else(|| "Fake Phone".into()),
        id: arg(&args, "--id").unwrap_or_else(|| "fakephone-1".into()),
        mode: arg(&args, "--mode").unwrap_or_else(|| "mic".into()),
        seconds: arg(&args, "--seconds").and_then(|v| v.parse().ok()).unwrap_or(10),
        loss: arg(&args, "--loss").and_then(|v| v.parse().ok()).unwrap_or(0.0),
        reorder: args.iter().any(|a| a == "--reorder"),
        auto_confirm: !args.iter().any(|a| a == "--no-confirm"),
        confirm_delay_ms: arg(&args, "--confirm-delay").and_then(|v| v.parse().ok()).unwrap_or(500),
        mute_after_ms: arg(&args, "--mute-after").and_then(|v| v.parse().ok()).unwrap_or(0),
    };
    let report = run(opts);
    println!("{:?}", report);
    if report.error.is_some() {
        std::process::exit(1);
    }
}
