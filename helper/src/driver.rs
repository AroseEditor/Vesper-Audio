use serde_json::{json, Value};
use std::mem::size_of;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use windows::core::{BOOL, GUID, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};

const HWID: &str = "ROOT\\VesperAudioCable";
const INF_NAME: &str = "VesperAudioCable.inf";
const CER_NAME: &str = "VesperAudioCable.cer";
const CLASS_MEDIA: GUID = GUID::from_u128(0x4d36e96c_e325_11ce_bfc1_08002be10318);
const NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "ntdll")]
extern "system" {
    fn NtQuerySystemInformation(class: u32, info: *mut u8, len: u32, ret: *mut u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn exec(program: &str, args: &[&str]) -> (bool, String) {
    match Command::new(program).args(args).creation_flags(NO_WINDOW).output() {
        Ok(o) => (
            o.status.success(),
            format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        ),
        Err(e) => (false, e.to_string()),
    }
}

fn test_signing() -> bool {
    let mut info = [0u8; 8];
    info[0] = 8;
    let mut ret = 0u32;
    let status = unsafe { NtQuerySystemInformation(103, info.as_mut_ptr(), 8, &mut ret) };
    status >= 0 && u32::from_le_bytes([info[4], info[5], info[6], info[7]]) & 2 != 0
}

fn secure_boot() -> bool {
    let sub = wide("SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State");
    let name = wide("UEFISecureBootEnabled");
    let mut value = 0u32;
    let mut size = 4u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    rc.is_ok() && value == 1
}

struct Nodes {
    set: HDEVINFO,
    found: Vec<(SP_DEVINFO_DATA, u32)>,
}

impl Drop for Nodes {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.set);
        }
    }
}

fn nodes() -> Result<Nodes, String> {
    unsafe {
        let enumerator = wide("ROOT");
        let set = SetupDiGetClassDevsW(None, PCWSTR(enumerator.as_ptr()), None, DIGCF_ALLCLASSES | DIGCF_PRESENT)
            .map_err(|e| e.message())?;
        let mut found = Vec::new();
        let mut i = 0;
        loop {
            let mut info = SP_DEVINFO_DATA { cbSize: size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
            if SetupDiEnumDeviceInfo(set, i, &mut info).is_err() {
                break;
            }
            i += 1;
            let mut buf = vec![0u8; 1024];
            let mut need = 0u32;
            if SetupDiGetDeviceRegistryPropertyW(set, &info, SPDRP_HARDWAREID, None, Some(&mut buf), Some(&mut need)).is_err() {
                continue;
            }
            let units: Vec<u16> = buf[..(need as usize).min(buf.len())]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let hit = units
                .split(|u| *u == 0)
                .any(|id| String::from_utf16_lossy(id).eq_ignore_ascii_case(HWID));
            if hit {
                let mut status = CM_DEVNODE_STATUS_FLAGS(0);
                let mut problem = CM_PROB(0);
                let _ = CM_Get_DevNode_Status(&mut status, &mut problem, info.DevInst, 0);
                found.push((info, problem.0));
            }
        }
        Ok(Nodes { set, found })
    }
}

pub fn status() -> Result<Value, String> {
    let n = nodes()?;
    let problem = n.found.first().map(|(_, p)| *p);
    Ok(json!({
        "ok": true,
        "nodePresent": !n.found.is_empty(),
        "problem": problem,
        "running": problem == Some(0),
        "testSigning": test_signing(),
        "secureBoot": secure_boot(),
    }))
}

fn create_node() -> Result<(), String> {
    unsafe {
        let set = SetupDiCreateDeviceInfoList(Some(&CLASS_MEDIA), None).map_err(|e| e.message())?;
        let mut info = SP_DEVINFO_DATA { cbSize: size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
        let class_name = wide("MEDIA");
        let result = (|| {
            SetupDiCreateDeviceInfoW(set, PCWSTR(class_name.as_ptr()), &CLASS_MEDIA, None, None, DICD_GENERATE_ID, Some(&mut info))
                .map_err(|e| e.message())?;
            let mut id: Vec<u16> = HWID.encode_utf16().collect();
            id.extend([0, 0]);
            let bytes = std::slice::from_raw_parts(id.as_ptr() as *const u8, id.len() * 2);
            SetupDiSetDeviceRegistryPropertyW(set, &mut info, SPDRP_HARDWAREID, Some(bytes)).map_err(|e| e.message())?;
            SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, Some(&info)).map_err(|e| e.message())
        })();
        let _ = SetupDiDestroyDeviceInfoList(set);
        result
    }
}

pub fn install(dir: &str) -> Result<Value, String> {
    let inf = Path::new(dir).join(INF_NAME);
    let cer = Path::new(dir).join(CER_NAME);
    if !inf.exists() || !cer.exists() {
        return Err("driver package is incomplete".into());
    }
    let cer = cer.to_string_lossy().to_string();
    for store in ["Root", "TrustedPublisher"] {
        let (ok, text) = exec("certutil.exe", &["-addstore", "-f", store, &cer]);
        if !ok {
            return Err(format!("certificate import into {store} failed: {}", text.trim()));
        }
    }
    let mut reboot = false;
    if !test_signing() {
        if secure_boot() {
            return Ok(json!({
                "ok": false,
                "message": "Secure Boot is enabled. Disable Secure Boot in firmware settings to load the unsigned Vesper Audio Cable driver."
            }));
        }
        let (ok, text) = exec("bcdedit.exe", &["/set", "testsigning", "on"]);
        if !ok {
            return Err(format!("enabling test mode failed: {}", text.trim()));
        }
        reboot = true;
    }
    if nodes()?.found.is_empty() {
        create_node()?;
    }
    let inf_w = wide(&inf.to_string_lossy());
    let hwid_w = wide(HWID);
    let mut needs_reboot = BOOL(0);
    let update = unsafe {
        UpdateDriverForPlugAndPlayDevicesW(None, PCWSTR(hwid_w.as_ptr()), PCWSTR(inf_w.as_ptr()), INSTALLFLAG_FORCE, Some(&mut needs_reboot))
    };
    if let Err(e) = update {
        return Err(format!("driver install failed: {}", e.message()));
    }
    let running = nodes()?.found.first().map(|(_, p)| *p == 0).unwrap_or(false);
    Ok(json!({
        "ok": true,
        "rebootRequired": reboot || needs_reboot.as_bool() || !running,
        "running": running,
    }))
}

fn published_inf() -> Option<String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    for entry in std::fs::read_dir(Path::new(&root).join("INF")).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("oem") && name.ends_with(".inf") {
            if let Ok(bytes) = std::fs::read(entry.path()) {
                let text = String::from_utf8_lossy(&bytes).to_lowercase().replace('\0', "");
                if text.contains("vesperaudiocable") {
                    return Some(name);
                }
            }
        }
    }
    None
}

pub fn uninstall() -> Result<Value, String> {
    let n = nodes()?;
    for (info, _) in &n.found {
        unsafe {
            SetupDiCallClassInstaller(DIF_REMOVE, n.set, Some(info)).map_err(|e| e.message())?;
        }
    }
    if let Some(oem) = published_inf() {
        let (ok, text) = exec("pnputil.exe", &["/delete-driver", &oem, "/uninstall", "/force"]);
        if !ok {
            return Err(format!("driver removal failed: {}", text.trim()));
        }
    }
    Ok(json!({ "ok": true }))
}
