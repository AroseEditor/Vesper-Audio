use crate::driver::exec;
use serde_json::{json, Value};
use std::path::Path;

fn rule_name(program: &str) -> String {
    let file = Path::new(program).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    format!("Vesper Audio Link - {}", file)
}

fn exists(name: &str) -> bool {
    let (ok, text) = exec("netsh.exe", &["advfirewall", "firewall", "show", "rule", &format!("name={}", name)]);
    ok && !text.to_lowercase().contains("no rules match")
}

pub fn status(programs: &[String]) -> Result<Value, String> {
    let allowed = !programs.is_empty() && programs.iter().all(|p| exists(&rule_name(p)));
    Ok(json!({ "ok": true, "allowed": allowed }))
}

pub fn add(programs: &[String]) -> Result<Value, String> {
    for program in programs {
        let name = rule_name(program);
        let _ = exec("netsh.exe", &["advfirewall", "firewall", "delete", "rule", &format!("name={}", name)]);
        let (ok, text) = exec(
            "netsh.exe",
            &["advfirewall", "firewall", "add", "rule", &format!("name={}", name), "dir=in", "action=allow", &format!("program={}", program), "enable=yes", "profile=private,domain", "protocol=any"],
        );
        if !ok {
            return Err(format!("could not add the firewall rule: {}", text.trim()));
        }
    }
    Ok(json!({ "ok": true, "allowed": true }))
}

pub fn remove(programs: &[String]) -> Result<Value, String> {
    for program in programs {
        let _ = exec("netsh.exe", &["advfirewall", "firewall", "delete", "rule", &format!("name={}", rule_name(program))]);
    }
    Ok(json!({ "ok": true, "allowed": false }))
}
