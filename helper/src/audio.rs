#![allow(non_snake_case)]
use serde_json::{json, Value};
use windows::core::{BOOL, GUID, HRESULT, PCWSTR, PWSTR};
use windows_core::{interface, IUnknown, IUnknown_Vtbl};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::WAVEFORMATEX;
use std::ffi::c_void;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantToBoolean, PropVariantToStringAlloc, PropVariantToUInt32, PROPVARIANT};
use windows::Win32::System::Com::*;
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;

const KEY_DEVICE_FORMAT: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xf19f064d_082c_4e27_bc73_6882a1bb8e4c), pid: 0 };
const KEY_DISABLE_SYSFX: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x1da5d803_d492_4edd_8c23_e0c0ffee7f0e), pid: 5 };
const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const KEY_LISTEN: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x24dbb0fc_9311_4b3d_9cf0_18ff155639d4), pid: 1 };
const KEY_LISTEN_TARGET: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x3d6e1656_2e50_4c4c_8d85_d0acae3c6c68), pid: 2 };

#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, device: PCWSTR, format: *mut *mut WAVEFORMATEX) -> HRESULT;
    fn GetDeviceFormat(&self, device: PCWSTR, default: BOOL, format: *mut *mut WAVEFORMATEX) -> HRESULT;
    fn ResetDeviceFormat(&self, device: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, device: PCWSTR, endpoint: *mut WAVEFORMATEX, mix: *mut WAVEFORMATEX) -> HRESULT;
    fn GetProcessingPeriod(&self, device: PCWSTR, default: BOOL, default_period: *mut i64, min_period: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, device: PCWSTR, period: *mut i64) -> HRESULT;
    fn GetShareMode(&self, device: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn SetShareMode(&self, device: PCWSTR, mode: *mut c_void) -> HRESULT;
    fn GetPropertyValue(&self, device: PCWSTR, fx: BOOL, key: *const PROPERTYKEY, value: *mut PROPVARIANT) -> HRESULT;
    fn SetPropertyValue(&self, device: PCWSTR, fx: BOOL, key: *const PROPERTYKEY, value: *mut PROPVARIANT) -> HRESULT;
    fn SetDefaultEndpoint(&self, device: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, device: PCWSTR, visible: BOOL) -> HRESULT;
}

fn policy() -> Result<IPolicyConfig, String> {
    unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.message()) }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn sysfx_enabled(id: &str) -> Option<bool> {
    let p = policy().ok()?;
    let w = wide(id);
    let mut pv = PROPVARIANT::default();
    let hr = unsafe { p.GetPropertyValue(PCWSTR(w.as_ptr()), BOOL(1), &KEY_DISABLE_SYSFX, &mut pv) };
    if hr.is_err() {
        return None;
    }
    unsafe { PropVariantToUInt32(&pv).ok().map(|v| v == 0) }
}

pub fn init() -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().map_err(|e| e.message()) }
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message()) }
}

fn take(p: PWSTR) -> String {
    let s = unsafe { p.to_string().unwrap_or_default() };
    unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
    s
}

fn device_id(d: &IMMDevice) -> String {
    unsafe { d.GetId().map(take).unwrap_or_default() }
}

fn default_id(en: &IMMDeviceEnumerator, flow: EDataFlow, role: ERole) -> String {
    unsafe { en.GetDefaultAudioEndpoint(flow, role).map(|d| device_id(&d)).unwrap_or_default() }
}

fn prop_string(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<String> {
    unsafe {
        let pv = store.GetValue(key).ok()?;
        let s = PropVariantToStringAlloc(&pv).ok()?;
        let text = take(s);
        if text.is_empty() { None } else { Some(text) }
    }
}

fn prop_bool(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<bool> {
    unsafe {
        let pv = store.GetValue(key).ok()?;
        PropVariantToBoolean(&pv).ok().map(|b| b.as_bool())
    }
}

fn format_of(store: &IPropertyStore) -> Value {
    unsafe {
        let Ok(pv) = store.GetValue(&KEY_DEVICE_FORMAT) else { return Value::Null };
        let blob = pv.Anonymous.Anonymous.Anonymous.blob;
        if blob.pBlobData.is_null() || blob.cbSize < 16 {
            return Value::Null;
        }
        let buf = std::slice::from_raw_parts(blob.pBlobData, blob.cbSize as usize);
        let channels = u16::from_le_bytes([buf[2], buf[3]]);
        let rate = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let bits = u16::from_le_bytes([buf[14], buf[15]]);
        json!({ "channels": channels, "sampleRate": rate, "bits": bits })
    }
}

fn cable_kind(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("vesper audio cable") {
        "vesper"
    } else if lower.starts_with("cable input") || lower.starts_with("cable output") || (lower.contains("vb-audio") && lower.contains("cable")) {
        "vb"
    } else {
        ""
    }
}

fn describe(d: &IMMDevice, flow: &str, def: &str, defc: &str) -> Value {
    let id = device_id(d);
    let store = unsafe { d.OpenPropertyStore(STGM_READ).ok() };
    let name = store
        .as_ref()
        .and_then(|s| prop_string(s, &PKEY_Device_FriendlyName))
        .unwrap_or_else(|| id.clone());
    let format = store.as_ref().map(format_of).unwrap_or(Value::Null);
    let (volume, muted) = unsafe {
        match d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
            Ok(v) => (
                v.GetMasterVolumeLevelScalar().ok().map(|x| (x * 100.0).round() as i32),
                v.GetMute().ok().map(|b| b.as_bool()),
            ),
            Err(_) => (None, None),
        }
    };
    let cable = cable_kind(&name);
    let mut o = json!({
        "id": id,
        "name": name,
        "flow": flow,
        "isDefault": id == def,
        "isDefaultComm": id == defc,
        "format": format,
        "volume": volume,
        "muted": muted,
        "vac": !cable.is_empty(),
        "cable": cable,
    });
    o["sysfx"] = json!(sysfx_enabled(&id));
    if let Some(s) = store.as_ref() {
        if flow == "capture" {
            o["listen"] = json!(prop_bool(s, &KEY_LISTEN).unwrap_or(false));
            o["listenTarget"] = json!(prop_string(s, &KEY_LISTEN_TARGET).unwrap_or_default());
        }
    }
    o
}

pub fn list() -> Result<Value, String> {
    let en = enumerator()?;
    let mut out = Vec::new();
    for (flow, label) in [(eCapture, "capture"), (eRender, "render")] {
        let def = default_id(&en, flow, eConsole);
        let defc = default_id(&en, flow, eCommunications);
        let coll = unsafe { en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(|e| e.message())? };
        let n = unsafe { coll.GetCount().map_err(|e| e.message())? };
        for i in 0..n {
            if let Ok(d) = unsafe { coll.Item(i) } {
                out.push(describe(&d, label, &def, &defc));
            }
        }
    }
    Ok(Value::Array(out))
}

fn open(id: &str) -> Result<IMMDevice, String> {
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { enumerator()?.GetDevice(PCWSTR(wide.as_ptr())).map_err(|e| e.message()) }
}

pub fn set_volume(id: &str, percent: f32) -> Result<Value, String> {
    let d = open(id)?;
    unsafe {
        let v: IAudioEndpointVolume = d.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        v.SetMasterVolumeLevelScalar((percent / 100.0).clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.message())?;
    }
    Ok(json!({ "ok": true }))
}

pub fn set_mute(id: &str, muted: bool) -> Result<Value, String> {
    let d = open(id)?;
    unsafe {
        let v: IAudioEndpointVolume = d.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        v.SetMute(muted, std::ptr::null()).map_err(|e| e.message())?;
    }
    Ok(json!({ "ok": true }))
}

fn write_prop(id: &str, key: &PROPERTYKEY, value: &PROPVARIANT) -> Result<Value, String> {
    let d = open(id)?;
    unsafe {
        let store = d.OpenPropertyStore(STGM_WRITE).map_err(|e| e.message())?;
        store.SetValue(key, value).map_err(|e| e.message())?;
        store.Commit().map_err(|e| e.message())?;
    }
    Ok(json!({ "ok": true }))
}

pub fn set_listen(id: &str, on: bool) -> Result<Value, String> {
    write_prop(id, &KEY_LISTEN, &PROPVARIANT::from(on))
}

pub fn set_sysfx(id: &str, on: bool) -> Result<Value, String> {
    let p = policy()?;
    let w = wide(id);
    let mut pv = PROPVARIANT::from(if on { 0u32 } else { 1u32 });
    let hr = unsafe { p.SetPropertyValue(PCWSTR(w.as_ptr()), BOOL(1), &KEY_DISABLE_SYSFX, &mut pv) };
    hr.ok().map_err(|e| e.message())?;
    match sysfx_enabled(id) {
        Some(now) if now == on => Ok(json!({ "ok": true })),
        _ => Err("Windows did not apply the audio enhancements change".into()),
    }
}

const KEY_DEVICE_DESC: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 2 };
const KEY_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0), pid: 14 };
const KEY_ADAPTER_NAME: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xb3f8fa53_0004_438e_9003_51a46e139bfc), pid: 6 };
const KEY_ICON_PATH: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0x259abffc_50a7_47ce_af08_68c9a7d73366), pid: 12 };

fn policy_text(id: &str, key: &PROPERTYKEY, value: &str) -> Result<(), String> {
    let p = policy()?;
    let w = wide(id);
    let text = wide(value);
    let mut pv = PROPVARIANT::default();
    unsafe {
        let mem = CoTaskMemAlloc(text.len() * 2) as *mut u16;
        std::ptr::copy_nonoverlapping(text.as_ptr(), mem, text.len());
        let inner = &mut *pv.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(mem);
    }
    unsafe { p.SetPropertyValue(PCWSTR(w.as_ptr()), BOOL(0), key, &mut pv) }.ok().map_err(|e| e.message())
}

pub fn rename(id: &str, name: &str, adapter: &str, icon: &str) -> Result<Value, String> {
    policy_text(id, &KEY_DEVICE_DESC, name)?;
    if !adapter.is_empty() {
        policy_text(id, &KEY_ADAPTER_NAME, adapter)?;
        let _ = policy_text(id, &KEY_FRIENDLY_NAME, &format!("{name} ({adapter})"));
    } else {
        let _ = policy_text(id, &KEY_FRIENDLY_NAME, name);
    }
    if !icon.is_empty() {
        policy_text(id, &KEY_ICON_PATH, icon)?;
    }
    Ok(json!({ "ok": true }))
}

pub fn brand(icon: &str) -> Result<Value, String> {
    let en = enumerator()?;
    let mut renamed = 0;
    for flow in [eCapture, eRender] {
        let coll = unsafe { en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(|e| e.message())? };
        let n = unsafe { coll.GetCount().map_err(|e| e.message())? };
        for i in 0..n {
            let Ok(d) = (unsafe { coll.Item(i) }) else { continue };
            let Ok(store) = (unsafe { d.OpenPropertyStore(STGM_READ) }) else { continue };
            let name = prop_string(&store, &PKEY_Device_FriendlyName).unwrap_or_default();
            if cable_kind(&name) == "vb" {
                rename(&device_id(&d), "Vesper Audio Cable", "Vesper Audio", icon)?;
                renamed += 1;
            }
        }
    }
    Ok(json!({ "ok": true, "renamed": renamed }))
}

