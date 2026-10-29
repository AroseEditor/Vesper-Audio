use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
pub struct Paired {
    pub id: String,
    pub name: String,
    pub model: String,
    pub fp: String,
    pub last_seen: u64,
}

pub struct Store {
    path: PathBuf,
    pub list: Vec<Paired>,
}

impl Store {
    pub fn open(dir: &Path) -> Store {
        let path = dir.join("paired.json");
        let list = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Vec<Paired>>(&b).ok()).unwrap_or_default();
        Store { path, list }
    }

    fn save(&self) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.list) {
            let tmp = self.path.with_extension("tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn by_fp(&self, fp: &str) -> Option<&Paired> {
        self.list.iter().find(|p| p.fp == fp)
    }

    pub fn upsert(&mut self, paired: Paired) {
        if let Some(existing) = self.list.iter_mut().find(|p| p.id == paired.id || p.fp == paired.fp) {
            *existing = paired;
        } else {
            self.list.push(paired);
        }
        self.save();
    }

    pub fn touch(&mut self, id: &str, now: u64) {
        if let Some(p) = self.list.iter_mut().find(|p| p.id == id) {
            p.last_seen = now;
            self.save();
        }
    }

    pub fn forget(&mut self, id: &str) {
        self.list.retain(|p| p.id != id);
        self.save();
    }
}
