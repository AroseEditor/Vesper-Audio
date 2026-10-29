use super::capture::Capture;
use super::convert::Scaler;
use super::cursor::Cursor;
use super::encode::{Encoder, Packet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Config {
    pub monitor: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
    pub idr_ms: u32,
}

#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub frames: u32,
    pub keys: u32,
    pub bytes: u64,
    pub encode_ms_sum: f64,
    pub encode_ms_max: f64,
    pub capture_width: u32,
    pub capture_height: u32,
}

fn even(value: u32) -> u32 {
    (value.max(2) / 2) * 2
}

pub fn run(config: &Config, stop: &AtomicBool, key_request: &AtomicBool, bitrate: &AtomicU32, on_packet: &mut dyn FnMut(Packet), stats: &mut Stats) -> Result<(), String> {
    let mut capture = Capture::open(config.monitor.as_deref()).map_err(|e| format!("could not capture the screen: {}", e))?;
    let (out_w, out_h) = (even(config.width), even(config.height));
    let mut encoder = Encoder::new(out_w, out_h, config.fps, config.kbps, config.idr_ms).map_err(|e| format!("could not start the H.264 encoder: {}", e))?;
    stats.capture_width = capture.width;
    stats.capture_height = capture.height;
    let interval = Duration::from_micros(1_000_000 / config.fps.max(1) as u64);
    let idr = Duration::from_millis(config.idr_ms as u64);
    let mut bgra: Vec<u8> = Vec::new();
    let mut nv12: Vec<u8> = Vec::new();
    let mut scaler: Option<Scaler> = None;
    let mut cursor: Option<Cursor> = None;
    let mut fresh = false;
    let mut have_frame = false;
    let mut last_encode = Instant::now() - interval;
    let mut last_key = Instant::now();
    let mut sent_bitrate = config.kbps;
    while !stop.load(Ordering::SeqCst) {
        let wait = interval.saturating_sub(last_encode.elapsed()).as_millis() as u32;
        match capture.grab(wait.max(1), &mut bgra) {
            Ok(true) => {
                fresh = true;
                have_frame = true;
            }
            Ok(false) => {}
            Err(e) => {
                if Capture::lost(&e) {
                    capture = Capture::open(config.monitor.as_deref()).map_err(|e| format!("lost the screen: {}", e))?;
                    scaler = None;
                    cursor = None;
                    have_frame = false;
                    continue;
                }
                return Err(format!("capture failed: {}", e));
            }
        }
        let now = Instant::now();
        let due = now.duration_since(last_encode) >= interval;
        let need_key = key_request.swap(false, Ordering::SeqCst) || now.duration_since(last_key) >= idr;
        if !have_frame || !due || !(fresh || need_key) {
            continue;
        }
        let (w, h) = (capture.width as usize, capture.height as usize);
        if scaler.as_ref().map(|s| !s.matches(w, h)).unwrap_or(true) {
            scaler = Some(Scaler::new(w, h, out_w as usize, out_h as usize));
        }
        if cursor.as_ref().map(|c| !c.matches(w, h)).unwrap_or(true) {
            cursor = Cursor::new(w, h);
        }
        if let Some(c) = cursor.as_mut() {
            c.draw(&mut bgra, capture.origin);
        }
        scaler.as_ref().unwrap().convert(&bgra, &mut nv12);
        let target = bitrate.load(Ordering::SeqCst);
        if target != 0 && target != sent_bitrate {
            encoder.set_bitrate(target);
            sent_bitrate = target;
        }
        let started = Instant::now();
        let packets = encoder.encode(&nv12, need_key).map_err(|e| format!("encoding failed: {}", e))?;
        let took = started.elapsed().as_secs_f64() * 1000.0;
        stats.encode_ms_sum += took;
        if took > stats.encode_ms_max {
            stats.encode_ms_max = took;
        }
        last_encode = now;
        fresh = false;
        for packet in packets {
            if packet.key {
                stats.keys += 1;
                last_key = now;
            }
            stats.bytes += packet.data.len() as u64;
            stats.frames += 1;
            on_packet(packet);
        }
    }
    Ok(())
}
