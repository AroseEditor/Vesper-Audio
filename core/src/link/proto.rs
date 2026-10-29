use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

pub const ALPN: &[u8] = b"vesper/1";
pub const MAX_FRAME: usize = 65536;

pub fn b64(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

pub fn unb64(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
    out
}

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn sas_code(client_fp: &[u8], server_fp: &[u8], client_nonce: &[u8], server_nonce: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(client_fp);
    hasher.update(server_fp);
    hasher.update(client_nonce);
    hasher.update(server_nonce);
    let digest = hasher.finalize();
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{:06}", value)
}

pub fn write_frame<W: Write>(writer: &mut W, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if body.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    writer.write_all(&out)?;
    writer.flush()
}

#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn take(&mut self) -> io::Result<Option<Value>> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let value = serde_json::from_slice::<Value>(&self.buf[4..4 + len]).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.buf.drain(..4 + len);
        Ok(Some(value))
    }

    pub fn poll<R: Read>(&mut self, reader: &mut R) -> io::Result<Option<Value>> {
        loop {
            if let Some(value) = self.take()? {
                return Ok(Some(value));
            }
            let mut chunk = [0u8; 4096];
            match reader.read(&mut chunk) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed")),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }
}
