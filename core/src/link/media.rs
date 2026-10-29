use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Instant;

pub const HEADER: usize = 16;
pub const KIND_AUDIO: u8 = 1;
pub const KIND_VIDEO: u8 = 2;
pub const KIND_FEEDBACK: u8 = 3;
pub const KIND_PUNCH: u8 = 4;
const REORDER: usize = 4;

#[derive(Clone, Copy, Debug)]
pub struct Header {
    pub kind: u8,
    pub flags: u8,
    pub sid: u32,
    pub seq: u32,
    pub ts: u32,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER] {
        let mut out = [0u8; HEADER];
        out[0] = 1;
        out[1] = self.kind;
        out[2] = self.flags;
        out[4..8].copy_from_slice(&self.sid.to_be_bytes());
        out[8..12].copy_from_slice(&self.seq.to_be_bytes());
        out[12..16].copy_from_slice(&self.ts.to_be_bytes());
        out
    }

    pub fn parse(bytes: &[u8]) -> Option<Header> {
        if bytes.len() < HEADER || bytes[0] != 1 {
            return None;
        }
        Some(Header {
            kind: bytes[1],
            flags: bytes[2],
            sid: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            seq: u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]),
            ts: u32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]),
        })
    }
}

#[derive(Clone)]
pub struct Crypto {
    cipher: Aes128Gcm,
    salt: [u8; 4],
}

impl Crypto {
    pub fn new(key: &[u8], salt: [u8; 4]) -> Option<Crypto> {
        Some(Crypto { cipher: Aes128Gcm::new_from_slice(key).ok()?, salt })
    }

    fn nonce(&self, kind: u8, seq: u32) -> [u8; 12] {
        let mut n = [0u8; 12];
        n[..4].copy_from_slice(&self.salt);
        n[4] = kind;
        n[8..12].copy_from_slice(&seq.to_be_bytes());
        n
    }

    pub fn seal(&self, header: &Header, plaintext: &[u8]) -> Vec<u8> {
        let head = header.encode();
        let nonce = self.nonce(header.kind, header.seq);
        let body = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &head })
            .unwrap_or_default();
        let mut out = Vec::with_capacity(HEADER + body.len());
        out.extend_from_slice(&head);
        out.extend_from_slice(&body);
        out
    }

    pub fn open(&self, packet: &[u8]) -> Option<(Header, Vec<u8>)> {
        let header = Header::parse(packet)?;
        let nonce = self.nonce(header.kind, header.seq);
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &packet[HEADER..], aad: &packet[..HEADER] })
            .ok()?;
        Some((header, plain))
    }
}

pub struct MicRx {
    next: Option<u32>,
    pending: BTreeMap<u32, Vec<u8>>,
}

impl MicRx {
    pub fn new() -> MicRx {
        MicRx { next: None, pending: BTreeMap::new() }
    }

    pub fn push(&mut self, seq: u32, pcm: Vec<u8>) -> Vec<(u32, u32, Vec<u8>)> {
        let mut out = Vec::new();
        let next = *self.next.get_or_insert(seq);
        if (seq.wrapping_sub(next) as i32) < 0 {
            return out;
        }
        self.pending.insert(seq, pcm);
        loop {
            let want = self.next.unwrap_or(seq);
            if let Some(frame) = self.pending.remove(&want) {
                out.push((want, 0, frame));
                self.next = Some(want.wrapping_add(1));
                continue;
            }
            if self.pending.len() > REORDER {
                let first = *self.pending.keys().next().unwrap();
                let lost = first.wrapping_sub(want);
                let frame = self.pending.remove(&first).unwrap();
                out.push((first, lost, frame));
                self.next = Some(first.wrapping_add(1));
                continue;
            }
            break;
        }
        out
    }
}

pub struct MediaSession {
    pub phone: String,
    pub kind: u8,
    pub crypto: Crypto,
    pub addr: Option<SocketAddr>,
    pub mic: MicRx,
    pub rx_packets: u64,
    pub rx_lost: u64,
    pub last_rx: Instant,
    pub tx_seq: u32,
}
