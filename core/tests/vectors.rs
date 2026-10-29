use serde_json::{json, Value};
use std::path::PathBuf;
use vesper_core::link::media::{Crypto, Header};
use vesper_core::link::proto::{hex, sas_code};

fn path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("proto").join("vectors.json")
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn build() -> Value {
    let client_fp: Vec<u8> = (0..32).map(|i| i as u8).collect();
    let server_fp: Vec<u8> = (0..32).map(|i| 255 - i as u8).collect();
    let client_nonce: Vec<u8> = (0..16).map(|i| (i * 3) as u8).collect();
    let server_nonce: Vec<u8> = (0..16).map(|i| (i * 5 + 1) as u8).collect();
    let key: Vec<u8> = (0..16).map(|i| (i * 7 + 2) as u8).collect();
    let salt = [0x10u8, 0x20, 0x30, 0x40];
    let crypto = Crypto::new(&key, salt).unwrap();
    let plain: Vec<u8> = (0..960).map(|i| ((i * 13) % 251) as u8).collect();
    let header = Header { kind: 1, flags: 0, sid: 7, seq: 42, ts: 20160 };
    let packet = crypto.seal(&header, &plain);
    let punch = crypto.seal(&Header { kind: 4, flags: 0, sid: 7, seq: 0, ts: 0 }, &[]);
    json!({
        "sas": [{
            "clientFp": hex(&client_fp), "serverFp": hex(&server_fp), "clientNonce": hex(&client_nonce), "serverNonce": hex(&server_nonce),
            "code": sas_code(&client_fp, &server_fp, &client_nonce, &server_nonce)
        }],
        "seal": [
            {"key": hex(&key), "salt": hex(&salt), "kind": 1, "flags": 0, "sid": 7, "seq": 42, "ts": 20160, "plain": hex(&plain), "packet": hex(&packet)},
            {"key": hex(&key), "salt": hex(&salt), "kind": 4, "flags": 0, "sid": 7, "seq": 0, "ts": 0, "plain": "", "packet": hex(&punch)}
        ]
    })
}

#[test]
fn vectors_file_matches_the_implementation() {
    if std::env::var("WRITE_VECTORS").is_ok() {
        std::fs::create_dir_all(path().parent().unwrap()).unwrap();
        std::fs::write(path(), serde_json::to_string_pretty(&build()).unwrap() + "\n").unwrap();
    }
    let stored: Value = serde_json::from_slice(&std::fs::read(path()).expect("proto/vectors.json is missing, run with WRITE_VECTORS=1")).unwrap();
    assert_eq!(stored, build(), "protocol vectors changed; the Android app must be updated together");
}

#[test]
fn a_sealed_vector_opens_to_its_plaintext() {
    let stored: Value = serde_json::from_slice(&std::fs::read(path()).unwrap()).unwrap();
    for item in stored["seal"].as_array().unwrap() {
        let salt = unhex(item["salt"].as_str().unwrap());
        let crypto = Crypto::new(&unhex(item["key"].as_str().unwrap()), [salt[0], salt[1], salt[2], salt[3]]).unwrap();
        let (header, plain) = crypto.open(&unhex(item["packet"].as_str().unwrap())).expect("the vector must open");
        assert_eq!(header.seq as u64, item["seq"].as_u64().unwrap());
        assert_eq!(hex(&plain), item["plain"].as_str().unwrap());
    }
}
