use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use vesper_core::link::{Config, Emit, Link};
use vesper_core::phone::{run, Opts, Report};

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vesper-link-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn start(name: &str) -> (Link, Events, PathBuf) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let emit: Emit = Arc::new(move |event, data| sink.lock().unwrap().push((event.to_string(), data)));
    let dir = temp(name);
    let link = Link::start(Config { data_dir: dir.clone(), name: "Test PC".into(), port: 0 }, emit).unwrap();
    (link, events, dir)
}

fn loopback(uri: &str) -> String {
    uri.split('&').map(|part| if part.starts_with("a=") { "a=127.0.0.1".to_string() } else { part.to_string() }).collect::<Vec<_>>().join("&")
}

fn opts(dir: PathBuf, qr: Option<String>, addr: Option<String>, seconds: u64, loss: f64) -> Opts {
    Opts { qr, addr, dir, name: "Test Phone".into(), id: "test-phone-1".into(), mode: "mic".into(), seconds, loss, reorder: loss > 0.0, auto_confirm: true, confirm_delay_ms: 300, mute_after_ms: 0, video_dump: None }
}

fn wait_for<F: Fn() -> bool>(limit: Duration, check: F) -> bool {
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn pcm_stats(events: &Events) -> (usize, u64) {
    let list = events.lock().unwrap();
    let mut frames = 0;
    let mut lost = 0;
    for (name, data) in list.iter() {
        if name == "pcm" {
            frames += 1;
            lost += data["lost"].as_u64().unwrap_or(0);
        }
    }
    (frames, lost)
}

fn mic_online(link: &Link) -> bool {
    link.phones().as_array().map(|a| a.iter().any(|p| p["online"] == true && p["paired"] == true && p["intent"] == "mic")).unwrap_or(false)
}

#[test]
fn qr_pairing_then_mic_stream_with_loss() {
    let (link, events, _dir) = start("qr");
    let uri = loopback(&link.pair_uri());
    let phone_dir = temp("qr-phone");
    let handle = thread::spawn(move || run(opts(phone_dir, Some(uri), None, 5, 0.1)));
    assert!(wait_for(Duration::from_secs(8), || mic_online(&link)), "phone never became paired and online with mic intent");
    let started = link.start_session("test-phone-1", "mic", None).unwrap();
    assert!(started["sid"].as_u64().unwrap() > 0);
    let report: Report = handle.join().unwrap();
    assert!(report.error.is_none(), "{:?}", report.error);
    assert!(report.paired && report.session);
    assert!(report.sent > 200, "sent {}", report.sent);
    let (frames, lost) = pcm_stats(&events);
    assert!(frames as u32 + 12 >= report.sent, "received {} of {}", frames, report.sent);
    assert!(lost as u32 + frames as u32 <= report.sent + report.dropped + 2, "frames {} lost {} sent {} dropped {}", frames, lost, report.sent, report.dropped);
    assert!(lost > 0, "loss injection should surface as lost frames");
    link.stop();
}

#[test]
fn a_qr_token_works_only_once() {
    let (link, _events, _dir) = start("once");
    let uri = loopback(&link.pair_uri());
    let first = run(opts(temp("once-a"), Some(uri.clone()), None, 1, 0.0));
    assert!(first.error.is_none() && first.paired, "{:?}", first);
    let second = run(Opts { id: "test-phone-2".into(), ..opts(temp("once-b"), Some(uri), None, 1, 0.0) });
    assert!(second.error.is_some(), "a reused token must be refused");
    assert!(!second.paired);
    link.stop();
}

#[test]
fn short_code_pairing_needs_the_pc_to_confirm() {
    let (link, events, _dir) = start("sas");
    let addr = format!("127.0.0.1:{}", link.port());
    let handle = thread::spawn(move || run(opts(temp("sas-phone"), None, Some(addr), 2, 0.0)));
    assert!(wait_for(Duration::from_secs(8), || events.lock().unwrap().iter().any(|(n, _)| n == "sas")));
    let code = events.lock().unwrap().iter().find(|(n, _)| n == "sas").map(|(_, d)| d["code"].as_str().unwrap().to_string()).unwrap();
    assert!(link.confirm("test-phone-1", true));
    let report = handle.join().unwrap();
    assert!(report.error.is_none(), "{:?}", report.error);
    assert!(report.paired);
    assert_eq!(report.sas.as_deref(), Some(code.as_str()));
    link.stop();
}

#[test]
fn declining_the_short_code_refuses_the_phone() {
    let (link, events, _dir) = start("decline");
    let addr = format!("127.0.0.1:{}", link.port());
    let handle = thread::spawn(move || run(opts(temp("decline-phone"), None, Some(addr), 2, 0.0)));
    assert!(wait_for(Duration::from_secs(8), || events.lock().unwrap().iter().any(|(n, _)| n == "sas")));
    assert!(link.confirm("test-phone-1", false));
    let report = handle.join().unwrap();
    assert!(report.error.is_some() && !report.paired);
    link.stop();
}

#[test]
fn a_paired_phone_reconnects_without_pairing() {
    let (link, events, _dir) = start("known");
    let uri = loopback(&link.pair_uri());
    let phone_dir = temp("known-phone");
    let phone_dir_again = phone_dir.clone();
    let first = run(opts(phone_dir.clone(), Some(uri), None, 1, 0.0));
    assert!(first.paired && first.error.is_none(), "{:?}", first);
    let addr = format!("127.0.0.1:{}", link.port());
    let second = run(opts(phone_dir, None, Some(addr), 1, 0.0));
    assert!(second.known && second.paired && second.error.is_none(), "{:?}", second);
    link.forget("test-phone-1");
    let third_addr = format!("127.0.0.1:{}", link.port());
    let third_dir = phone_dir_again;
    let handle = thread::spawn(move || run(opts(third_dir, None, Some(third_addr), 1, 0.0)));
    assert!(wait_for(Duration::from_secs(8), || events.lock().unwrap().iter().any(|(n, _)| n == "sas")), "a forgotten phone must be asked to pair again");
    assert!(link.confirm("test-phone-1", false));
    let third = handle.join().unwrap();
    assert!(!third.known && !third.paired);
    link.stop();
}

#[test]
fn muting_on_the_phone_is_reported_and_stops_the_audio() {
    let (link, events, _dir) = start("mute");
    let uri = loopback(&link.pair_uri());
    let handle = thread::spawn(move || run(Opts { mute_after_ms: 1500, ..opts(temp("mute-phone"), Some(uri), None, 4, 0.0) }));
    assert!(wait_for(Duration::from_secs(8), || mic_online(&link)));
    link.start_session("test-phone-1", "mic", None).unwrap();
    assert!(wait_for(Duration::from_secs(6), || link.phones().as_array().map(|a| a.iter().any(|p| p["muted"] == true)).unwrap_or(false)), "the PC never saw the phone mute");
    let at_mute = pcm_stats(&events).0;
    thread::sleep(Duration::from_millis(600));
    let after = pcm_stats(&events).0;
    assert!(after <= at_mute + 8, "audio kept arriving after mute: {} to {}", at_mute, after);
    let report = handle.join().unwrap();
    assert!(report.error.is_none(), "{:?}", report.error);
    link.stop();
}

#[cfg(windows)]
#[test]
fn the_screen_reaches_the_phone_as_valid_h264() {
    if vesper_core::display::capture::monitors().is_empty() {
        println!("no monitor available, skipping");
        return;
    }
    let (link, _events, _dir) = start("display");
    let uri = loopback(&link.pair_uri());
    let dump = std::env::temp_dir().join(format!("vesper-display-test-{}.h264", std::process::id()));
    let dump_for_phone = dump.clone();
    let phone_dir = temp("display-phone");
    let handle = thread::spawn(move || run(Opts { mode: "display".into(), video_dump: Some(dump_for_phone), ..opts(phone_dir, Some(uri), None, 7, 0.0) }));
    assert!(wait_for(Duration::from_secs(8), || link.phones().as_array().map(|a| a.iter().any(|p| p["online"] == true && p["paired"] == true && p["intent"] == "display")).unwrap_or(false)));
    link.start_session("test-phone-1", "display", Some(serde_json::json!({"w": 1280, "h": 720, "fps": 30, "kbps": 6000}))).unwrap();
    let report = handle.join().unwrap();
    assert!(report.error.is_none(), "{:?}", report.error);
    assert!(report.frames >= 1, "no frame arrived");
    assert!(report.keys >= 1 && report.saw_parameter_sets, "the first frame must be a keyframe with SPS and PPS: {:?}", report);
    assert!(report.video_bytes > 2000);
    link.stop();
    let size = std::fs::metadata(&dump).map(|m| m.len()).unwrap_or(0);
    assert_eq!(size, report.video_bytes);
}

#[test]
fn bluetooth_pairing_lets_the_phone_join_over_wifi_as_a_known_phone() {
    let (link, _events, _dir) = start("bt");
    let phone_dir = temp("bt-phone");
    let identity = vesper_core::link::tls::load_or_create(&phone_dir, "fakephone").unwrap();
    let uri = link.pair_uri();
    let token = uri.split('&').find(|p| p.starts_with("t=")).unwrap()[2..].to_string();
    let hello = serde_json::json!({"t": "bt.hello", "token": token, "id": "test-phone-1", "name": "Bluetooth Phone", "model": "Test", "fp": vesper_core::link::proto::hex(&identity.fp)});
    let reply = link.bluetooth_message(&hello).unwrap();
    assert_eq!(reply["ok"], true, "{}", reply);
    assert_eq!(reply["port"].as_u64().unwrap(), link.port() as u64);
    assert_eq!(reply["fp"].as_str().unwrap(), vesper_core::link::proto::hex(&link.fingerprint()));
    let again = link.bluetooth_message(&hello).unwrap();
    assert_eq!(again["ok"], false, "a Bluetooth token must work only once");
    let addr = format!("127.0.0.1:{}", link.port());
    let report = run(opts(phone_dir, None, Some(addr), 1, 0.0));
    assert!(report.error.is_none(), "{:?}", report.error);
    assert!(report.known && report.paired, "the phone paired over Bluetooth must be known over Wi-Fi: {:?}", report);
    link.stop();
}
