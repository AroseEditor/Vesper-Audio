use crate::driver::{create_node_for, exec, nodes, published_inf, wide};
use serde_json::{json, Value};
use std::mem::size_of;
use std::path::Path;
use windows::core::{BOOL, GUID, PCWSTR};
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

pub fn status() -> Result<Value, String> {
    let found = nodes(VDD_HWID)?;
    let problem = found.found.first().map(|(_, p)| *p);
    Ok(json!({
        "ok": true,
        "nodePresent": !found.found.is_empty(),
        "problem": problem,
        "running": problem == Some(0),
        "monitors": monitors(),
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
            return Err("that display was not found".into());
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
