pub fn nv12_len(width: usize, height: usize) -> usize {
    width * height * 3 / 2
}

pub struct Scaler {
    src_w: usize,
    src_h: usize,
    dst_w: usize,
    dst_h: usize,
    xmap: Vec<usize>,
    ymap: Vec<usize>,
}

impl Scaler {
    pub fn new(src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> Scaler {
        let xmap = (0..dst_w).map(|x| (x * src_w / dst_w).min(src_w - 1) * 4).collect();
        let ymap = (0..dst_h).map(|y| (y * src_h / dst_h).min(src_h - 1)).collect();
        Scaler { src_w, src_h, dst_w, dst_h, xmap, ymap }
    }

    pub fn matches(&self, src_w: usize, src_h: usize) -> bool {
        self.src_w == src_w && self.src_h == src_h
    }

    pub fn convert(&self, bgra: &[u8], nv12: &mut Vec<u8>) {
        let (dw, dh) = (self.dst_w, self.dst_h);
        nv12.resize(nv12_len(dw, dh), 0);
        let (luma, chroma) = nv12.split_at_mut(dw * dh);
        let stride = self.src_w * 4;
        for y in 0..dh {
            let row = &bgra[self.ymap[y] * stride..(self.ymap[y] + 1) * stride];
            let out = &mut luma[y * dw..(y + 1) * dw];
            for x in 0..dw {
                let p = self.xmap[x];
                let b = row[p] as i32;
                let g = row[p + 1] as i32;
                let r = row[p + 2] as i32;
                out[x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
            }
        }
        for y in 0..dh / 2 {
            let top = &bgra[self.ymap[y * 2] * stride..(self.ymap[y * 2] + 1) * stride];
            let bottom = &bgra[self.ymap[y * 2 + 1] * stride..(self.ymap[y * 2 + 1] + 1) * stride];
            let out = &mut chroma[y * dw..(y + 1) * dw];
            for x in 0..dw / 2 {
                let p0 = self.xmap[x * 2];
                let p1 = self.xmap[x * 2 + 1];
                let b = (top[p0] as i32 + top[p1] as i32 + bottom[p0] as i32 + bottom[p1] as i32) >> 2;
                let g = (top[p0 + 1] as i32 + top[p1 + 1] as i32 + bottom[p0 + 1] as i32 + bottom[p1 + 1] as i32) >> 2;
                let r = (top[p0 + 2] as i32 + top[p1 + 2] as i32 + bottom[p0 + 2] as i32 + bottom[p1 + 2] as i32) >> 2;
                out[x * 2] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128) as u8;
                out[x * 2 + 1] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_and_black_map_to_limited_range_luma() {
        let scaler = Scaler::new(4, 4, 4, 4);
        let mut frame = vec![0u8; 4 * 4 * 4];
        for (i, px) in frame.chunks_mut(4).enumerate() {
            let v = if i % 2 == 0 { 255 } else { 0 };
            px.copy_from_slice(&[v, v, v, 255]);
        }
        let mut out = Vec::new();
        scaler.convert(&frame, &mut out);
        assert_eq!(out.len(), 24);
        assert_eq!(out[0], 235);
        assert_eq!(out[1], 16);
    }

    #[test]
    fn scaling_down_keeps_the_picture() {
        let scaler = Scaler::new(8, 8, 4, 4);
        let frame = vec![255u8; 8 * 8 * 4];
        let mut out = Vec::new();
        scaler.convert(&frame, &mut out);
        assert!(out[..16].iter().all(|v| *v == 235));
        assert!(out[16..].iter().all(|v| (*v as i32 - 128).abs() <= 2));
    }
}
