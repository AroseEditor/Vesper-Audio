use crate::driver::{create_node_for, exec, nodes, published_inf, wide};
use serde_json::{json, Value};
use std::mem::size_of;
use std::path::Path;
use windows::core::{BOOL, GUID, PCWSTR};
use windows::Win32::Devices::Display::{SetDisplayConfig, SDC_APPLY, SDC_TOPOLOGY_EXTEND};
use windows::Win32::Foundation::POINTL;
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Graphics::Gdi::*;

const VDD_HWID: &str = "Root\\MttVDD";
const CLASS_DISPLAY: GUID = GUID::from_u128(0x4d36e968_e325_11ce_bfc1_08002be10318);
const SETTINGS_DIR: &str = "C:\\VirtualDisplayDriver";

fn text(units: &[u16]) -> String {
    let len = units.iter().position(|u| *u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..len])
}

pub fn monitors() -> Value {
    let mut list = Vec::new();
    unsafe {
        let mut index = 0;
        loop {
            let mut device = DISPLAY_DEVICEW { cb: size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
            if !EnumDisplayDevicesW(PCWSTR::null(), index, &mut device, 0).as_bool() {
                break;
            }
            index += 1;
            if (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 == 0 {
                continue;
            }
            let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
            if !EnumDisplaySettingsW(PCWSTR(device.DeviceName.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode).as_bool() {
                continue;
            }
            let position = mode.Anonymous1.Anonymous2.dmPosition;
            let name = text(&device.DeviceName);
            let adapter = text(&device.DeviceString);
            list.push(json!({
                "device": name,
                "adapter": adapter,
                "virtual": adapter.to_lowercase().contains("virtual display") || adapter.to_lowercase().contains("mtt"),
                "primary": (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE).0 != 0,
                "left": position.x,
                "top": position.y,
                "width": mode.dmPelsWidth,
                "height": mode.dmPelsHeight,
                "rate": mode.dmDisplayFrequency,
            }));
        }
    }
    Value::Array(list)
}

struct Output {
    name: String,
    attached: bool,
    primary: bool,
}

fn is_virtual(adapter: &str) -> bool {
    let lower = adapter.to_lowercase();
    lower.contains("virtual display") || lower.contains("mtt")
}

fn virtual_output() -> Option<Output> {
    unsafe {
        let mut index = 0;
        loop {
            let mut device = DISPLAY_DEVICEW { cb: size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
            if !EnumDisplayDevicesW(PCWSTR::null(), index, &mut device, 0).as_bool() {
                return None;
            }
            index += 1;
            if is_virtual(&text(&device.DeviceString)) {
                return Some(Output {
                    name: text(&device.DeviceName),
                    attached: (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 != 0,
                    primary: (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE).0 != 0,
                });
            }
        }
    }
}

pub fn modes() -> Result<Value, String> {
    let output = virtual_output().ok_or("the virtual display was not found")?;
    let name = wide(&output.name);
    let mut list = Vec::new();
    unsafe {
        let mut index = 0;
        loop {
            let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
            if !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(index), &mut mode).as_bool() {
                break;
            }
            index += 1;
            list.push(json!([mode.dmPelsWidth, mode.dmPelsHeight, mode.dmDisplayFrequency, mode.dmBitsPerPel]));
        }
    }
    Ok(json!({ "ok": true, "device": output.name, "modes": list }))
}

fn best_mode(name: &[u16], width: u32, height: u32, rate: u32) -> Option<(u32, u32, u32)> {
    let mut best: Option<((bool, u64, u32), (u32, u32, u32))> = None;
    unsafe {
        let mut index = 0;
        loop {
            let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
            if !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(index), &mut mode).as_bool() {
                break;
            }
            index += 1;
            if mode.dmPelsWidth == 0 || mode.dmPelsHeight == 0 {
                continue;
            }
            let area = (mode.dmPelsWidth as u64 * mode.dmPelsHeight as u64).abs_diff(width as u64 * height as u64);
            let key = (mode.dmPelsWidth != width || mode.dmPelsHeight != height, area, mode.dmDisplayFrequency.abs_diff(rate));
            if best.as_ref().map(|(k, _)| key < *k).unwrap_or(true) {
                best = Some((key, (mode.dmPelsWidth, mode.dmPelsHeight, mode.dmDisplayFrequency)));
            }
        }
    }
    best.map(|(_, mode)| mode)
}

fn apply(name: &[u16], mode: &DEVMODEW) -> Result<(), String> {
    unsafe {
        let staged = ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(mode), None, CDS_UPDATEREGISTRY | CDS_NORESET, None);
        if staged != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("Windows refused the display change ({})", staged.0));
        }
        let applied = ChangeDisplaySettingsExW(PCWSTR::null(), None, None, CDS_TYPE(0), None);
        if applied != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("Windows could not apply the display change ({})", applied.0));
        }
    }
    Ok(())
}

fn settle(wanted: bool) -> bool {
    for _ in 0..30 {
        if virtual_output().map(|o| o.attached) == Some(wanted) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

fn snapshot() -> Vec<(String, u32, u32, u32)> {
    monitors()
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|m| m["virtual"] != true)
                .map(|m| (m["device"].as_str().unwrap_or("").to_string(), m["width"].as_u64().unwrap_or(0) as u32, m["height"].as_u64().unwrap_or(0) as u32, m["rate"].as_u64().unwrap_or(0) as u32))
                .collect()
        })
        .unwrap_or_default()
}

fn restore(before: &[(String, u32, u32, u32)]) {
    let now = snapshot();
    for (device, w, h, rate) in before {
        if now.iter().any(|(d, nw, nh, nr)| d == device && (nw != w || nh != h || nr != rate)) {
            let _ = set_mode(device, *w, *h, *rate);
        }
    }
}

pub fn attach(width: u32, height: u32, rate: u32) -> Result<Value, String> {
    let output = virtual_output().ok_or("the virtual display was not found, is the driver installed")?;
    if output.attached {
        let current = monitors();
        return Ok(json!({ "ok": true, "device": output.name, "monitors": current }));
    }
    let before = snapshot();
    let name = wide(&output.name);
    let (w, h, f) = best_mode(&name, width, height, rate).unwrap_or((width, height, rate));
    let right = monitors().as_array().map(|list| list.iter().map(|m| m["left"].as_i64().unwrap_or(0) + m["width"].as_i64().unwrap_or(0)).max().unwrap_or(0)).unwrap_or(0);
    let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    mode.dmPelsWidth = w;
    mode.dmPelsHeight = h;
    mode.dmDisplayFrequency = f;
    mode.dmBitsPerPel = 32;
    mode.Anonymous1.Anonymous2.dmPosition = POINTL { x: right as i32, y: 0 };
    mode.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_BITSPERPEL;
    if apply(&name, &mode).is_err() || !settle(true) {
        let extended = unsafe { SetDisplayConfig(None, None, SDC_APPLY | SDC_TOPOLOGY_EXTEND) };
        if extended != 0 || !settle(true) {
            return Err(format!("Windows did not turn the virtual display on ({})", extended));
        }
        let _ = set_mode(&output.name, w, h, f);
    }
    restore(&before);
    Ok(json!({ "ok": true, "device": output.name, "monitors": monitors() }))
}

pub fn detach() -> Result<Value, String> {
    let output = match virtual_output() {
        Some(o) => o,
        None => return Ok(json!({ "ok": true, "attached": false })),
    };
    if !output.attached {
        return Ok(json!({ "ok": true, "attached": false }));
    }
    if output.primary {
        return Err("the virtual display is the main display, it was left on".into());
    }
    let before = snapshot();
    let name = wide(&output.name);
    let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    mode.Anonymous1.Anonymous2.dmPosition = POINTL { x: 0, y: 0 };
    mode.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
    apply(&name, &mode)?;
    settle(false);
    restore(&before);
    Ok(json!({ "ok": true, "attached": false, "monitors": monitors() }))
}

pub fn status() -> Result<Value, String> {
    let found = nodes(VDD_HWID)?;
    let problem = found.found.first().map(|(_, p)| *p);
    Ok(json!({
        "ok": true,
        "nodePresent": !found.found.is_empty(),
        "problem": problem,
        "running": problem == Some(0),
        "monitors": monitors(),
        "virtual": virtual_output().map(|o| json!({ "device": o.name, "attached": o.attached })),
    }))
}

pub fn install(dir: &str) -> Result<Value, String> {
    let inf = Path::new(dir).join("MttVDD.inf");
    let cat = Path::new(dir).join("mttvdd.cat");
    if !inf.exists() || !cat.exists() {
        return Err("the virtual display driver package is incomplete".into());
    }
    let cer = Path::new(dir).join("signer.cer");
    let script = format!(
        "$s = Get-AuthenticodeSignature -LiteralPath '{}'; if ($s.Status -ne 'Valid') {{ exit 3 }}; Export-Certificate -Cert $s.SignerCertificate -FilePath '{}' -Force | Out-Null",
        cat.to_string_lossy().replace('\'', "''"),
        cer.to_string_lossy().replace('\'', "''")
    );
    let (ok, output) = exec("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    if !ok || !cer.exists() {
        return Err(format!("the driver signature is not valid: {}", output.trim()));
    }
    let (ok, output) = exec("certutil.exe", &["-addstore", "-f", "TrustedPublisher", &cer.to_string_lossy()]);
    if !ok {
        return Err(format!("could not trust the driver publisher: {}", output.trim()));
    }
    if nodes(VDD_HWID)?.found.is_empty() {
        create_node_for(VDD_HWID, &CLASS_DISPLAY, "Display")?;
    }
    let inf_w = wide(&inf.to_string_lossy());
    let hwid_w = wide(VDD_HWID);
    let mut reboot = BOOL(0);
    unsafe {
        UpdateDriverForPlugAndPlayDevicesW(None, PCWSTR(hwid_w.as_ptr()), PCWSTR(inf_w.as_ptr()), INSTALLFLAG_FORCE, Some(&mut reboot)).map_err(|e| format!("driver install failed: {}", e.message()))?;
    }
    let _ = std::fs::create_dir_all(SETTINGS_DIR);
    let settings = Path::new(SETTINGS_DIR).join("vdd_settings.xml");
    if !settings.exists() {
        if let Ok(bytes) = std::fs::read(Path::new(dir).join("vdd_settings.xml")) {
            let _ = std::fs::write(&settings, bytes);
        }
    }
    let _ = exec("icacls.exe", &[SETTINGS_DIR, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T"]);
    let after = status()?;
    Ok(json!({ "ok": true, "rebootRequired": reboot.as_bool() && after["running"] != true, "status": after }))
}

pub fn uninstall() -> Result<Value, String> {
    let found = nodes(VDD_HWID)?;
    for (info, _) in &found.found {
        unsafe {
            SetupDiCallClassInstaller(DIF_REMOVE, found.set, Some(info)).map_err(|e| e.message())?;
        }
    }
    while let Some(oem) = published_inf("mttvdd") {
        let (ok, output) = exec("pnputil.exe", &["/delete-driver", &oem, "/uninstall", "/force"]);
        if !ok {
            return Err(format!("driver removal failed: {}", output.trim()));
        }
    }
    Ok(json!({ "ok": true }))
}

pub fn set_mode(device: &str, width: u32, height: u32, rate: u32) -> Result<Value, String> {
    unsafe {
        let name = wide(device);
        let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
        if !EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode).as_bool() {
            return Err(format!("that display was not found ({})", device));
        }
        mode.dmPelsWidth = width;
        mode.dmPelsHeight = height;
        if rate > 0 {
            mode.dmDisplayFrequency = rate;
        }
        mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | if rate > 0 { DM_DISPLAYFREQUENCY } else { DEVMODE_FIELD_FLAGS(0) };
        let result = ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(&mode), None, CDS_UPDATEREGISTRY, None);
        if result != DISP_CHANGE_SUCCESSFUL {
            return Err(format!("Windows refused that display mode ({})", result.0));
        }
    }
    Ok(json!({ "ok": true, "monitors": monitors() }))
}
