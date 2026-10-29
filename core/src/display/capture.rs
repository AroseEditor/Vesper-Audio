use windows::core::{Error, Interface, Result, HRESULT};
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

pub struct Capture {
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    dup: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
    pub width: u32,
    pub height: u32,
    pub origin: (i32, i32),
}

pub fn monitors() -> Vec<(String, RECT)> {
    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return out,
        };
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                if let Ok(desc) = output.GetDesc() {
                    if desc.AttachedToDesktop.as_bool() {
                        let len = desc.DeviceName.iter().position(|c| *c == 0).unwrap_or(desc.DeviceName.len());
                        out.push((String::from_utf16_lossy(&desc.DeviceName[..len]), desc.DesktopCoordinates));
                    }
                }
                o += 1;
            }
            a += 1;
        }
    }
    out
}

impl Capture {
    pub fn open(name: Option<&str>) -> Result<Capture> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let mut found: Option<(IDXGIAdapter1, IDXGIOutput1, RECT)> = None;
            let mut a = 0;
            'search: while let Ok(adapter) = factory.EnumAdapters1(a) {
                let mut o = 0;
                while let Ok(output) = adapter.EnumOutputs(o) {
                    let desc = output.GetDesc()?;
                    let len = desc.DeviceName.iter().position(|c| *c == 0).unwrap_or(desc.DeviceName.len());
                    let device_name = String::from_utf16_lossy(&desc.DeviceName[..len]);
                    let wanted = match name {
                        Some(n) => device_name.eq_ignore_ascii_case(n),
                        None => desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0,
                    };
                    if desc.AttachedToDesktop.as_bool() && wanted {
                        found = Some((adapter.clone(), output.cast::<IDXGIOutput1>()?, desc.DesktopCoordinates));
                        break 'search;
                    }
                    o += 1;
                }
                a += 1;
            }
            let (adapter, output, rect) = found.ok_or_else(|| Error::new(HRESULT(-2147024894), "monitor not found"))?;
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?;
            let device = device.ok_or_else(|| Error::new(HRESULT(-2147467259), "no device"))?;
            let context = context.ok_or_else(|| Error::new(HRESULT(-2147467259), "no context"))?;
            let dup = output.DuplicateOutput(&device)?;
            Ok(Capture { context, device, dup, staging: None, width: (rect.right - rect.left) as u32, height: (rect.bottom - rect.top) as u32, origin: (rect.left, rect.top) })
        }
    }

    pub fn grab(&mut self, timeout_ms: u32, bgra: &mut Vec<u8>) -> Result<bool> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(false),
                Err(e) => return Err(e),
            }
            let result = (|| -> Result<bool> {
                if info.LastPresentTime == 0 {
                    return Ok(false);
                }
                let texture: ID3D11Texture2D = resource.as_ref().ok_or_else(|| Error::new(HRESULT(-2147467259), "no frame"))?.cast()?;
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                if self.staging.is_none() {
                    let mut copy = desc;
                    copy.Usage = D3D11_USAGE_STAGING;
                    copy.BindFlags = 0;
                    copy.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                    copy.MiscFlags = 0;
                    let mut created: Option<ID3D11Texture2D> = None;
                    self.device.CreateTexture2D(&copy, None, Some(&mut created))?;
                    self.staging = created;
                }
                let staging = self.staging.as_ref().unwrap();
                self.context.CopyResource(staging, &texture);
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
                let w = desc.Width as usize;
                let h = desc.Height as usize;
                self.width = desc.Width;
                self.height = desc.Height;
                bgra.resize(w * h * 4, 0);
                let src = mapped.pData as *const u8;
                for y in 0..h {
                    std::ptr::copy_nonoverlapping(src.add(y * mapped.RowPitch as usize), bgra.as_mut_ptr().add(y * w * 4), w * 4);
                }
                self.context.Unmap(staging, 0);
                Ok(true)
            })();
            let _ = self.dup.ReleaseFrame();
            result
        }
    }

    pub fn lost(error: &Error) -> bool {
        error.code() == DXGI_ERROR_ACCESS_LOST
    }
}

