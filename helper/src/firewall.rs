use crate::driver::exec;
use serde_json::{json, Value};
use std::path::Path;

fn rule_name(program: &str) -> String {
    let file = Path::new(program).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    format!("Vesper Audio Link - {}", file)
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn powershell(script: &str) -> (bool, String) {
    exec("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
}

fn allowed(program: &str) -> bool {
    let script = format!(
        "$r = Get-NetFirewallRule -DisplayName {} -ErrorAction SilentlyContinue | Where-Object {{ $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' }}; if ($r) {{ 'yes' }} else {{ 'no' }}",
        quote(&rule_name(program))
    );
    let (ok, text) = powershell(&script);
    ok && text.trim().ends_with("yes")
}

pub fn status(programs: &[String]) -> Result<Value, String> {
    let all = !programs.is_empty() && programs.iter().all(|p| allowed(p));
    let (_, profile) = powershell("(Get-NetConnectionProfile | Select-Object -First 1 -ExpandProperty NetworkCategory)");
    Ok(json!({ "ok": true, "allowed": all, "profile": profile.trim() }))
}

pub fn add(programs: &[String]) -> Result<Value, String> {
    for program in programs {
        let name = quote(&rule_name(program));
        let script = format!(
            "Remove-NetFirewallRule -DisplayName {name} -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName {name} -Direction Inbound -Action Allow -Program {program} -Profile Any -Protocol Any -Enabled True | Out-Null",
            name = name,
            program = quote(program)
        );
        let (ok, text) = powershell(&script);
        if !ok {
            return Err(format!("could not add the firewall rule: {}", text.trim()));
        }
    }
    Ok(json!({ "ok": true, "allowed": true }))
}

pub fn remove(programs: &[String]) -> Result<Value, String> {
    for program in programs {
        let script = format!("Remove-NetFirewallRule -DisplayName {} -ErrorAction SilentlyContinue", quote(&rule_name(program)));
        let _ = powershell(&script);
    }
    Ok(json!({ "ok": true, "allowed": false }))
}
