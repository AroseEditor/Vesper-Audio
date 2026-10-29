use std::ffi::c_void;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO};

pub struct Cursor {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    bits: *mut c_void,
    width: usize,
    height: usize,
}

unsafe impl Send for Cursor {}

impl Cursor {
    pub fn new(width: usize, height: usize) -> Option<Cursor> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let mut info = BITMAPINFO::default();
            info.bmiHeader = BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: width as i32, biHeight: -(height as i32), biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            if bits.is_null() {
                let _ = DeleteDC(dc);
                return None;
            }
            let old = SelectObject(dc, bitmap.into());
            Some(Cursor { dc, bitmap, old, bits, width, height })
        }
    }

    pub fn matches(&self, width: usize, height: usize) -> bool {
        self.width == width && self.height == height
    }

    pub fn draw(&mut self, frame: &mut [u8], origin: (i32, i32)) {
        unsafe {
            let mut cursor = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
            if GetCursorInfo(&mut cursor).is_err() || (cursor.flags.0 & CURSOR_SHOWING.0) == 0 {
                return;
            }
            let mut icon = ICONINFO::default();
            if GetIconInfo(cursor.hCursor.into(), &mut icon).is_err() {
                return;
            }
            let x = cursor.ptScreenPos.x - icon.xHotspot as i32 - origin.0;
            let y = cursor.ptScreenPos.y - icon.yHotspot as i32 - origin.1;
            if !icon.hbmMask.is_invalid() {
                let _ = DeleteObject(icon.hbmMask.into());
            }
            if !icon.hbmColor.is_invalid() {
                let _ = DeleteObject(icon.hbmColor.into());
            }
            if x < -64 || y < -64 || x > self.width as i32 || y > self.height as i32 {
                return;
            }
            let len = self.width * self.height * 4;
            std::ptr::copy_nonoverlapping(frame.as_ptr(), self.bits as *mut u8, len);
            let _ = DrawIconEx(self.dc, x, y, cursor.hCursor.into(), 0, 0, 0, None, DI_NORMAL);
            std::ptr::copy_nonoverlapping(self.bits as *const u8, frame.as_mut_ptr(), len);
        }
    }
}

impl Drop for Cursor {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

#[allow(dead_code)]
fn _hwnd(_: HWND) {}
