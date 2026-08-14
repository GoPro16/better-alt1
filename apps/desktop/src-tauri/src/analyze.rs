//! Pixel analysis that runs natively against a stored frame.
//!
//! The whole point is that the answers are small. `find_subimage` on a 4K frame reads
//! megabytes and returns a handful of coordinates; doing the same work in the webview
//! would mean shipping those megabytes first. Alt1 makes the same split — `bindGetPixel`
//! and `bindFindSubImg` are native and return numbers.

use serde::{Deserialize, Serialize};

use crate::{capture::Rect, store::StoredFrame};

const BYTES_PER_PIXEL: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: u32,
    pub y: u32,
}

/// A template to search for: tightly packed RGBA8, `width * height * 4` bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    /// Pixels whose alpha is below this are treated as "don't care", so a template can
    /// describe an irregular shape without matching its background.
    #[serde(default)]
    pub alpha_threshold: u8,
}

impl Template {
    pub fn is_valid(&self) -> bool {
        self.width > 0
            && self.height > 0
            && self.pixels.len() == self.width as usize * self.height as usize * BYTES_PER_PIXEL
    }
}

/// Packed 0xAARRGGBB, matching what the frontend expects from a single-pixel read.
pub fn pixel_at(frame: &StoredFrame, x: u32, y: u32) -> Option<u32> {
    if x >= frame.width || y >= frame.height {
        return None;
    }
    let offset = (y as usize * frame.width as usize + x as usize) * BYTES_PER_PIXEL;
    let [r, g, b, a] = frame.pixels[offset..offset + 4] else { return None };
    Some(u32::from_be_bytes([a, r, g, b]))
}

/// Clamp a rect to the frame. Returns `None` when there is no overlap.
pub fn clamp_to_frame(frame: &StoredFrame, rect: Rect) -> Option<Rect> {
    let left = rect.x.max(0);
    let top = rect.y.max(0);
    let right = (rect.x + rect.width as i32).min(frame.width as i32);
    let bottom = (rect.y + rect.height as i32).min(frame.height as i32);
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        x: left,
        y: top,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

/// Copy a sub-rectangle out as tightly packed RGBA8. `rect` must already be clamped.
pub fn copy_region(frame: &StoredFrame, rect: Rect) -> Vec<u8> {
    let row_bytes = rect.width as usize * BYTES_PER_PIXEL;
    let mut out = Vec::with_capacity(row_bytes * rect.height as usize);
    for row in 0..rect.height {
        let start = ((rect.y as u32 + row) as usize * frame.width as usize + rect.x as usize)
            * BYTES_PER_PIXEL;
        out.extend_from_slice(&frame.pixels[start..start + row_bytes]);
    }
    out
}

/// Content fingerprint of a region. Mirrors `frameSignature` in `packages/core` so the
/// two agree on what "changed" means.
pub fn signature(frame: &StoredFrame, rect: Option<Rect>, samples: usize) -> u32 {
    let area = match rect.and_then(|r| clamp_to_frame(frame, r)) {
        Some(r) => r,
        None => Rect { x: 0, y: 0, width: frame.width, height: frame.height },
    };

    let mut hash: u32 = 0x811c_9dc5;
    hash = mix(hash, area.width);
    hash = mix(hash, area.height);

    let total = area.width as usize * area.height as usize;
    if total == 0 {
        return hash;
    }

    // `samples == 0` means "no sampling limit", so fall back to a stride of 1.
    let stride = total.checked_div(samples).unwrap_or(1).max(1);
    for index in (0..total).step_by(stride) {
        let x = area.x as usize + index % area.width as usize;
        let y = area.y as usize + index / area.width as usize;
        let offset = (y * frame.width as usize + x) * BYTES_PER_PIXEL;
        hash = mix(hash, frame.pixels[offset] as u32);
        hash = mix(hash, frame.pixels[offset + 1] as u32);
        hash = mix(hash, frame.pixels[offset + 2] as u32);
    }
    hash
}

fn mix(hash: u32, value: u32) -> u32 {
    (hash ^ (value & 0xff)).wrapping_mul(0x0100_0193)
}

/// Locate a template within a frame.
///
/// `tolerance` is the maximum absolute per-channel difference still counted as a match,
/// which matters because screen capture is not bit-exact: compositing, scaling and colour
/// management all perturb pixels by a step or two.
pub fn find_subimage(
    frame: &StoredFrame,
    template: &Template,
    search: Option<Rect>,
    tolerance: u8,
    max_matches: usize,
) -> Vec<Point> {
    let mut matches = Vec::new();
    if !template.is_valid() || max_matches == 0 {
        return matches;
    }
    if template.width > frame.width || template.height > frame.height {
        return matches;
    }

    let area = match search.and_then(|r| clamp_to_frame(frame, r)) {
        Some(r) => r,
        None => Rect { x: 0, y: 0, width: frame.width, height: frame.height },
    };

    // Last origin at which the template still fits inside the search area.
    let last_x = (area.x as u32 + area.width).saturating_sub(template.width);
    let last_y = (area.y as u32 + area.height).saturating_sub(template.height);

    for y in area.y as u32..=last_y {
        for x in area.x as u32..=last_x {
            if matches_at(frame, template, x, y, tolerance) {
                matches.push(Point { x, y });
                if matches.len() >= max_matches {
                    return matches;
                }
            }
        }
    }

    matches
}

fn matches_at(
    frame: &StoredFrame,
    template: &Template,
    origin_x: u32,
    origin_y: u32,
    tolerance: u8,
) -> bool {
    for ty in 0..template.height {
        let frame_row = (origin_y + ty) as usize * frame.width as usize;
        let template_row = ty as usize * template.width as usize;

        for tx in 0..template.width {
            let t = (template_row + tx as usize) * BYTES_PER_PIXEL;
            // Transparent template pixels are wildcards.
            if template.pixels[t + 3] < template.alpha_threshold {
                continue;
            }

            let f = (frame_row + (origin_x + tx) as usize) * BYTES_PER_PIXEL;
            for channel in 0..3 {
                let difference = frame.pixels[f + channel].abs_diff(template.pixels[t + channel]);
                if difference > tolerance {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FrameStore;

    /// Builds a frame through the store, so tests exercise the real `StoredFrame`.
    fn frame(width: u32, height: u32, pixels: Vec<u8>) -> (FrameStore, u64) {
        let store = FrameStore::new();
        let handle = store.insert(
            width,
            height,
            0,
            Rect { x: 0, y: 0, width, height },
            pixels,
        );
        (store, handle.id)
    }

    fn solid(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut pixels = Vec::new();
        for _ in 0..width * height {
            pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }
        pixels
    }

    #[test]
    fn pixel_at_packs_argb_and_bounds_check() {
        let (store, id) = frame(2, 1, vec![1, 2, 3, 255, 4, 5, 6, 255]);
        store.with(id, |f| {
            assert_eq!(pixel_at(f, 0, 0), Some(0xff01_0203));
            assert_eq!(pixel_at(f, 1, 0), Some(0xff04_0506));
            assert_eq!(pixel_at(f, 2, 0), None);
            assert_eq!(pixel_at(f, 0, 1), None);
        });
    }

    #[test]
    fn copy_region_extracts_rows_in_order() {
        // 2x2, each pixel tagged by index.
        let pixels: Vec<u8> = (0..16).collect();
        let (store, id) = frame(2, 2, pixels);
        store.with(id, |f| {
            let rect = clamp_to_frame(f, Rect { x: 1, y: 0, width: 1, height: 2 }).unwrap();
            assert_eq!(copy_region(f, rect), vec![4, 5, 6, 7, 12, 13, 14, 15]);
        });
    }

    #[test]
    fn clamp_rejects_a_rect_entirely_outside() {
        let (store, id) = frame(4, 4, solid(4, 4, [0, 0, 0]));
        store.with(id, |f| {
            assert!(clamp_to_frame(f, Rect { x: 10, y: 0, width: 2, height: 2 }).is_none());
            let clamped = clamp_to_frame(f, Rect { x: -2, y: -2, width: 10, height: 10 }).unwrap();
            assert_eq!((clamped.x, clamped.y, clamped.width, clamped.height), (0, 0, 4, 4));
        });
    }

    #[test]
    fn signature_changes_with_content_and_is_stable_otherwise() {
        let (store_a, a) = frame(8, 8, solid(8, 8, [10, 20, 30]));
        let (store_b, b) = frame(8, 8, solid(8, 8, [10, 20, 30]));
        let (store_c, c) = frame(8, 8, solid(8, 8, [10, 20, 31]));

        let sig_a = store_a.with(a, |f| signature(f, None, 4096)).unwrap();
        let sig_b = store_b.with(b, |f| signature(f, None, 4096)).unwrap();
        let sig_c = store_c.with(c, |f| signature(f, None, 4096)).unwrap();

        assert_eq!(sig_a, sig_b);
        assert_ne!(sig_a, sig_c);
    }

    #[test]
    fn signature_of_a_region_ignores_changes_outside_it() {
        let mut pixels = solid(8, 8, [5, 5, 5]);
        let (store, id) = frame(8, 8, pixels.clone());
        let region = Rect { x: 0, y: 0, width: 2, height: 2 };
        let before = store.with(id, |f| signature(f, Some(region), 4096)).unwrap();

        // Change the far corner, outside the region.
        let offset = (7 * 8 + 7) * BYTES_PER_PIXEL;
        pixels[offset] = 200;
        let (store2, id2) = frame(8, 8, pixels);
        let after = store2.with(id2, |f| signature(f, Some(region), 4096)).unwrap();

        assert_eq!(before, after);
    }

    #[test]
    fn find_subimage_locates_an_exact_match() {
        // 4x4 black with a 2x2 red block at (1,1).
        let mut pixels = solid(4, 4, [0, 0, 0]);
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let offset = ((1 + dy) * 4 + (1 + dx)) * BYTES_PER_PIXEL;
            pixels[offset] = 255;
        }
        let (store, id) = frame(4, 4, pixels);

        let template = Template {
            width: 2,
            height: 2,
            pixels: solid(2, 2, [255, 0, 0]),
            alpha_threshold: 1,
        };

        let found = store.with(id, |f| find_subimage(f, &template, None, 0, 10)).unwrap();
        assert_eq!(found, vec![Point { x: 1, y: 1 }]);
    }

    #[test]
    fn find_subimage_respects_tolerance() {
        let (store, id) = frame(2, 2, solid(2, 2, [100, 100, 100]));
        let template =
            Template { width: 1, height: 1, pixels: solid(1, 1, [104, 100, 100]), alpha_threshold: 1 };

        let strict = store.with(id, |f| find_subimage(f, &template, None, 0, 10)).unwrap();
        assert!(strict.is_empty(), "should not match with zero tolerance");

        let loose = store.with(id, |f| find_subimage(f, &template, None, 4, 10)).unwrap();
        assert_eq!(loose.len(), 4, "every pixel matches within tolerance 4");
    }

    #[test]
    fn find_subimage_treats_transparent_template_pixels_as_wildcards() {
        let (store, id) = frame(2, 1, vec![9, 9, 9, 255, 200, 200, 200, 255]);
        // Second pixel is transparent, so its colour must be ignored.
        let template = Template {
            width: 2,
            height: 1,
            pixels: vec![9, 9, 9, 255, 1, 2, 3, 0],
            alpha_threshold: 1,
        };

        let found = store.with(id, |f| find_subimage(f, &template, None, 0, 10)).unwrap();
        assert_eq!(found, vec![Point { x: 0, y: 0 }]);
    }

    #[test]
    fn find_subimage_honours_max_matches_and_search_area() {
        let (store, id) = frame(4, 1, solid(4, 1, [7, 7, 7]));
        let template =
            Template { width: 1, height: 1, pixels: solid(1, 1, [7, 7, 7]), alpha_threshold: 1 };

        let capped = store.with(id, |f| find_subimage(f, &template, None, 0, 2)).unwrap();
        assert_eq!(capped.len(), 2);

        let searched = store
            .with(id, |f| {
                find_subimage(f, &template, Some(Rect { x: 2, y: 0, width: 2, height: 1 }), 0, 10)
            })
            .unwrap();
        assert_eq!(searched, vec![Point { x: 2, y: 0 }, Point { x: 3, y: 0 }]);
    }

    #[test]
    fn find_subimage_rejects_a_malformed_or_oversized_template() {
        let (store, id) = frame(2, 2, solid(2, 2, [0, 0, 0]));

        let wrong_len = Template { width: 2, height: 2, pixels: vec![0; 4], alpha_threshold: 1 };
        assert!(!wrong_len.is_valid());
        assert!(store.with(id, |f| find_subimage(f, &wrong_len, None, 0, 10)).unwrap().is_empty());

        let too_big =
            Template { width: 4, height: 4, pixels: solid(4, 4, [0, 0, 0]), alpha_threshold: 1 };
        assert!(store.with(id, |f| find_subimage(f, &too_big, None, 0, 10)).unwrap().is_empty());
    }
}
