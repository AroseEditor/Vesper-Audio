use std::mem::ManuallyDrop;
use windows::core::{Error, Interface, Result};
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4};
use windows::Win32::Foundation::VARIANT_BOOL;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

fn variant_u32(value: u32) -> VARIANT {
    VARIANT { Anonymous: VARIANT_0 { Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt: VT_UI4, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { ulVal: value } }) } }
}

fn variant_bool(value: bool) -> VARIANT {
    VARIANT { Anonymous: VARIANT_0 { Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt: VT_BOOL, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { boolVal: VARIANT_BOOL(if value { -1 } else { 0 }) } }) } }
}

pub struct Encoder {
    transform: IMFTransform,
    api: ICodecAPI,
    header: Vec<u8>,
    pts: i64,
    step: i64,
}

pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
}

fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

fn has_nal(data: &[u8], kind: u8) -> bool {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && (data[i + 2] == 1 || (data[i + 2] == 0 && i + 4 < data.len() && data[i + 3] == 1)) {
            let at = if data[i + 2] == 1 { i + 3 } else { i + 4 };
            if at < data.len() && (data[at] & 0x1f) == kind {
                return true;
            }
            i = at;
        } else {
            i += 1;
        }
    }
    false
}

impl Encoder {
    pub fn new(width: u32, height: u32, fps: u32, kbps: u32, gop_ms: u32) -> Result<Encoder> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
            let transform: IMFTransform = CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER)?;
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, kbps * 1000)?;
            output.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            output.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
            transform.SetOutputType(0, &output, 0)?;
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            transform.SetInputType(0, &input, 0)?;
            let api: ICodecAPI = transform.cast()?;
            let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &variant_bool(true));
            let _ = api.SetValue(&CODECAPI_AVEncCommonRateControlMode, &variant_u32(eAVEncCommonRateControlMode_CBR.0 as u32));
            let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variant_u32(kbps * 1000));
            let _ = api.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &variant_u32(0));
            let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &variant_u32((fps * gop_ms / 1000).max(1)));
            let mut header = Vec::new();
            if let Ok(current) = transform.GetOutputCurrentType(0) {
                let size = current.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).unwrap_or(0) as usize;
                if size > 0 {
                    header.resize(size, 0);
                    let mut written = 0u32;
                    let _ = current.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut header, Some(&mut written));
                    header.truncate(written as usize);
                }
            }
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Encoder { transform, api, header, pts: 0, step: 10_000_000 / fps.max(1) as i64 })
        }
    }

    pub fn set_bitrate(&self, kbps: u32) {
        unsafe {
            let _ = self.api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &variant_u32(kbps * 1000));
        }
    }

    pub fn encode(&mut self, nv12: &[u8], force_key: bool) -> Result<Vec<Packet>> {
        unsafe {
            if force_key {
                let _ = self.api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variant_u32(1));
            }
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut data: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), data, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(self.pts)?;
            sample.SetSampleDuration(self.step)?;
            self.pts += self.step;
            self.transform.ProcessInput(0, &sample, 0)?;
            let mut out = Vec::new();
            loop {
                let info = self.transform.GetOutputStreamInfo(0)?;
                let mut buffers = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(None), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
                if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                    let made = MFCreateSample()?;
                    made.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(1 << 20))?)?;
                    buffers[0].pSample = ManuallyDrop::new(Some(made));
                }
                let mut status = 0u32;
                match self.transform.ProcessOutput(0, &mut buffers, &mut status) {
                    Ok(()) => {
                        let produced = ManuallyDrop::take(&mut buffers[0].pSample);
                        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
                        if let Some(sample) = produced {
                            let contiguous = sample.ConvertToContiguousBuffer()?;
                            let mut ptr: *mut u8 = std::ptr::null_mut();
                            let mut length = 0u32;
                            contiguous.Lock(&mut ptr, None, Some(&mut length))?;
                            let mut bytes = std::slice::from_raw_parts(ptr, length as usize).to_vec();
                            contiguous.Unlock()?;
                            let key = has_nal(&bytes, 5);
                            if key && !has_nal(&bytes, 7) && !self.header.is_empty() {
                                let mut joined = self.header.clone();
                                joined.extend_from_slice(&bytes);
                                bytes = joined;
                            }
                            out.push(Packet { data: bytes, key });
                        }
                    }
                    Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => {
                        let _ = ManuallyDrop::take(&mut buffers[0].pSample);
                        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
                        break;
                    }
                    Err(e) => {
                        let _ = ManuallyDrop::take(&mut buffers[0].pSample);
                        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
                        return Err(Error::new(e.code(), "the H.264 encoder failed"));
                    }
                }
            }
            Ok(out)
        }
    }
}
