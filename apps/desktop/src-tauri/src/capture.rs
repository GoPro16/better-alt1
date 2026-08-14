//! Passive screen capture.
//!
//! Everything here reads pixels that are *already on the user's screen* and nothing else.
//! No input synthesis, no process memory, no hooks — see CLAUDE.md. If a change to this
//! module needs any of those, the change is wrong.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use xcap::{Monitor, Window};

use crate::error::{AppError, AppResult};

/// Must stay byte-identical to the decoder in `packages/core/src/frame.ts`.
pub const FRAME_HEADER_BYTES: usize = 24;
const FRAME_MAGIC: &[u8; 4] = b"BA1F";
const FRAME_VERSION: u8 = 1;
const PIXEL_FORMAT_RGBA8: u8 = 0;
const BYTES_PER_PIXEL: usize = 4;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Monitor,
    Window,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub id: String,
    pub kind: TargetKind,
    pub title: String,
    pub app_name: String,
    pub bounds: Rect,
    pub scale_factor: f32,
    pub is_primary: bool,
    pub is_minimized: bool,
}

/// Enumerate every monitor and top-level window we could capture.
///
/// Individual entries are skipped rather than failing the whole call: windows come and go
/// between enumeration and querying, and a dead handle is normal, not exceptional.
pub fn list_targets() -> AppResult<Vec<CaptureTarget>> {
    let mut targets = Vec::new();

    for monitor in Monitor::all()? {
        match describe_monitor(&monitor) {
            Ok(target) => targets.push(target),
            Err(err) => eprintln!("skipping monitor: {err}"),
        }
    }

    for window in Window::all()? {
        match describe_window(&window) {
            // Zero-sized and untitled windows are tool windows and invisible shells;
            // they are never what a user means to capture.
            Ok(Some(target)) => targets.push(target),
            Ok(None) => {}
            Err(err) => eprintln!("skipping window: {err}"),
        }
    }

    Ok(targets)
}

fn describe_monitor(monitor: &Monitor) -> AppResult<CaptureTarget> {
    Ok(CaptureTarget {
        id: format!("monitor:{}", monitor.id()?),
        kind: TargetKind::Monitor,
        title: monitor.friendly_name().or_else(|_| monitor.name())?,
        app_name: String::new(),
        bounds: Rect {
            x: monitor.x()?,
            y: monitor.y()?,
            width: monitor.width()?,
            height: monitor.height()?,
        },
        scale_factor: monitor.scale_factor()?,
        is_primary: monitor.is_primary()?,
        is_minimized: false,
    })
}

fn describe_window(window: &Window) -> AppResult<Option<CaptureTarget>> {
    let width = window.width()?;
    let height = window.height()?;
    let title = window.title()?;
    if width == 0 || height == 0 || title.trim().is_empty() {
        return Ok(None);
    }

    Ok(Some(CaptureTarget {
        id: format!("window:{}", window.id()?),
        kind: TargetKind::Window,
        title,
        app_name: window.app_name().unwrap_or_default(),
        bounds: Rect { x: window.x()?, y: window.y()?, width, height },
        // Windows inherit the scale of whichever monitor they sit on.
        scale_factor: window.current_monitor().and_then(|m| m.scale_factor()).unwrap_or(1.0),
        is_primary: false,
        is_minimized: window.is_minimized()?,
    }))
}

/// Grab one frame, encoded with the binary header the frontend expects.
///
/// `region` is in target-local coordinates and is clipped to the target; only a region
/// with no overlap at all is an error.
///
/// `max_dimension` caps the longest side, downsampling before encoding. This matters a
/// lot: an untouched 4K grab is ~33 MB, and pushing that through the webview's IPC
/// channel stalls the UI for seconds. Callers that only need to *show* the frame should
/// always pass a cap; only analysis wants native resolution, and then only of a region.
pub fn capture(
    target_id: &str,
    region: Option<Rect>,
    max_dimension: Option<u32>,
    max_bytes: Option<usize>,
) -> AppResult<Vec<u8>> {
    let grabbed = capture_pixels(target_id, region, max_dimension)?;

    // Applied last, so it is the final word on payload size regardless of max_dimension.
    let (width, height, pixels) = match max_bytes {
        Some(budget) => fit_to_bytes(grabbed.width, grabbed.height, grabbed.pixels, budget),
        None => (grabbed.width, grabbed.height, grabbed.pixels),
    };

    Ok(encode_frame(width, height, &pixels, grabbed.captured_at))
}

/// What a grab produced: the target-local area covered, and the sampled pixels.
///
/// `source` and `width`/`height` differ whenever downsampling applied — `source` describes
/// the region of the *target* that was read, in target-local coordinates, which is what
/// callers need to map a preview coordinate back to the target. Keeping them separate
/// avoids the class of bug where a downscaled frame's dimensions get mistaken for the area
/// it covers.
pub struct Capture {
    pub source: Rect,
    pub width: u32,
    pub height: u32,
    pub captured_at: u64,
    pub pixels: Vec<u8>,
}

/// Grab pixels without wrapping them for the wire.
///
/// This is what the handle-based path uses: pixels go straight into the frame store and
/// are never encoded for transfer, so there is no payload budget to respect.
pub fn capture_pixels(
    target_id: &str,
    region: Option<Rect>,
    max_dimension: Option<u32>,
) -> AppResult<Capture> {
    let started = std::time::Instant::now();

    let (kind, raw_id) = target_id
        .split_once(':')
        .ok_or_else(|| AppError::BadTargetId(target_id.to_owned()))?;
    let numeric_id: u32 = raw_id
        .parse()
        .map_err(|_| AppError::BadTargetId(target_id.to_owned()))?;

    let (source, width, height, pixels) = match kind {
        "monitor" => capture_monitor(numeric_id, region)?,
        "window" => capture_window(numeric_id, region)?,
        _ => return Err(AppError::BadTargetId(target_id.to_owned())),
    };
    let grabbed = started.elapsed();

    let (width, height, pixels) = match max_dimension {
        Some(max) => downsample(width, height, pixels, max),
        None => (width, height, pixels),
    };

    // Debug builds print to the `tauri dev` terminal; this is the only place the real
    // cost of a grab is visible, and it is the first thing to check when the UI stalls.
    #[cfg(debug_assertions)]
    eprintln!(
        "capture {target_id}: grab {}ms, total {}ms, {}x{}, {:.1} MiB native",
        grabbed.as_millis(),
        started.elapsed().as_millis(),
        width,
        height,
        pixels.len() as f64 / (1024.0 * 1024.0),
    );
    #[cfg(not(debug_assertions))]
    let _ = grabbed;

    Ok(Capture { source, width, height, captured_at: now_millis(), pixels })
}

/// Nearest-neighbour decimation to fit a longest-side budget.
///
/// Deliberately not averaging: this feeds pixel inspection and template matching, where a
/// blended pixel is a fabricated colour that exists nowhere on screen. Dropping pixels
/// keeps every surviving one truthful.
fn downsample(width: u32, height: u32, pixels: Vec<u8>, max_dimension: u32) -> (u32, u32, Vec<u8>) {
    let longest = width.max(height);
    if max_dimension == 0 || longest <= max_dimension {
        return (width, height, pixels);
    }
    // Round up so the result never exceeds max_dimension.
    decimate(width, height, pixels, longest.div_ceil(max_dimension) as usize)
}

/// Decimate until the encoded frame fits `max_bytes`.
///
/// Exists because the webview's IPC transport has a hard cliff: measured on Windows,
/// 64 KiB and 512 KiB round trip in ~11ms, while 2 MiB and 4 MiB both cost ~4.1 *seconds*
/// — a fixed penalty, not a bandwidth limit. Crossing it freezes the UI. Staying under it
/// by construction is the difference between a responsive app and one that hangs, so this
/// is a correctness constraint rather than an optimisation.
fn fit_to_bytes(
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    max_bytes: usize,
) -> (u32, u32, Vec<u8>) {
    let budget = max_bytes.saturating_sub(FRAME_HEADER_BYTES) / BYTES_PER_PIXEL;
    let current = width as usize * height as usize;
    if budget == 0 || current <= budget {
        return (width, height, pixels);
    }

    // Area shrinks with the square of the step, so start from the square root and nudge
    // up until it genuinely fits — integer rounding can leave the first guess a hair over.
    let mut step = ((current as f64 / budget as f64).sqrt().ceil() as usize).max(2);
    while (width as usize).div_ceil(step) * (height as usize).div_ceil(step) > budget {
        step += 1;
    }

    decimate(width, height, pixels, step)
}

/// Keep every `step`-th pixel in both axes.
fn decimate(width: u32, height: u32, pixels: Vec<u8>, step: usize) -> (u32, u32, Vec<u8>) {
    if step <= 1 {
        return (width, height, pixels);
    }

    let out_width = (width as usize).div_ceil(step);
    let out_height = (height as usize).div_ceil(step);

    let mut out = Vec::with_capacity(out_width * out_height * BYTES_PER_PIXEL);
    for row in 0..out_height {
        let source_row = row * step;
        for column in 0..out_width {
            let source = (source_row * width as usize + column * step) * BYTES_PER_PIXEL;
            out.extend_from_slice(&pixels[source..source + BYTES_PER_PIXEL]);
        }
    }

    (out_width as u32, out_height as u32, out)
}

/// Returns `(target-local area read, width, height, rgba)`.
fn capture_monitor(id: u32, region: Option<Rect>) -> AppResult<(Rect, u32, u32, Vec<u8>)> {
    let monitor = Monitor::all()?
        .into_iter()
        .find(|m| m.id().map(|found| found == id).unwrap_or(false))
        .ok_or_else(|| AppError::UnknownTarget(format!("monitor:{id}")))?;

    let full_width = monitor.width()?;
    let full_height = monitor.height()?;

    // Monitors can crop during the grab, which is cheaper than copying the whole display.
    if let Some(requested) = region {
        let clipped = clip(requested, full_width, full_height)?;
        let image = monitor.capture_region(clipped.x as u32, clipped.y as u32, clipped.width, clipped.height)?;
        let source = Rect { width: image.width(), height: image.height(), ..clipped };
        return Ok((source, image.width(), image.height(), image.into_raw()));
    }

    let image = monitor.capture_image()?;
    let source = Rect { x: 0, y: 0, width: image.width(), height: image.height() };
    Ok((source, image.width(), image.height(), image.into_raw()))
}

/// Read the screen area the window occupies, rather than the window's own device context.
///
/// This is deliberate and it is what Alt1 does. Capturing a window via `PrintWindow` /
/// `BitBlt` on its own DC asks the window to repaint itself, which makes a
/// hardware-accelerated game client **visibly flash**, and costs ~533ms for a 4K client
/// against ~22ms for an 800x600 screen region on the same machine.
///
/// The trade-off: we see whatever is actually on screen there. Anything covering the
/// client is captured instead of it, and a minimised client cannot be read at all. That
/// matches the passive-observer model — we look at the screen, same as the user does.
fn capture_window(id: u32, region: Option<Rect>) -> AppResult<(Rect, u32, u32, Vec<u8>)> {
    let label = format!("window:{id}");
    let window = Window::all()?
        .into_iter()
        .find(|w| w.id().map(|found| found == id).unwrap_or(false))
        .ok_or_else(|| AppError::UnknownTarget(label.clone()))?;

    if window.is_minimized()? {
        return Err(AppError::WindowMinimized(label));
    }

    // Clip the requested region to the window first, so coordinates stay window-local
    // from the caller's point of view.
    let window_width = window.width()?;
    let window_height = window.height()?;
    let wanted = match region {
        Some(requested) => clip(requested, window_width, window_height)?,
        None => Rect { x: 0, y: 0, width: window_width, height: window_height },
    };

    // Translate into monitor-local coordinates. Both origins are virtual-desktop
    // coordinates and either can be negative, as on a display above the primary.
    let monitor = window.current_monitor()?;
    let on_monitor = Rect {
        x: window.x()? - monitor.x()? + wanted.x,
        y: window.y()? - monitor.y()? + wanted.y,
        width: wanted.width,
        height: wanted.height,
    };

    let visible = clip(on_monitor, monitor.width()?, monitor.height()?)
        .map_err(|_| AppError::WindowOffscreen(label))?;

    let image = monitor.capture_region(
        visible.x as u32,
        visible.y as u32,
        visible.width,
        visible.height,
    )?;

    // Report the area in *window*-local coordinates, not monitor-local: callers asked for a
    // region of the window and must get answers in the same space. `visible` may be smaller
    // than requested when the window hangs off the edge of its display.
    let source = Rect {
        x: wanted.x,
        y: wanted.y,
        width: image.width(),
        height: image.height(),
    };
    Ok((source, image.width(), image.height(), image.into_raw()))
}

/// Intersect a requested region with `0,0,width,height`. Errors only on no overlap.
fn clip(region: Rect, width: u32, height: u32) -> AppResult<Rect> {
    let left = region.x.max(0);
    let top = region.y.max(0);
    let right = (region.x + region.width as i32).min(width as i32);
    let bottom = (region.y + region.height as i32).min(height as i32);

    if right <= left || bottom <= top {
        return Err(AppError::RegionOutOfBounds { region, width, height });
    }

    Ok(Rect {
        x: left,
        y: top,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn encode_frame(width: u32, height: u32, pixels: &[u8], captured_at_ms: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + pixels.len());
    out.extend_from_slice(FRAME_MAGIC);
    out.push(FRAME_VERSION);
    out.push(PIXEL_FORMAT_RGBA8);
    out.extend_from_slice(&[0, 0]); // reserved
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&captured_at_ms.to_le_bytes());
    out.extend_from_slice(pixels);
    debug_assert_eq!(out.len(), FRAME_HEADER_BYTES + pixels.len());
    out
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout_matches_the_typescript_decoder() {
        let pixels = [1u8, 2, 3, 4];
        let frame = encode_frame(1, 1, &pixels, 0x0102_0304_0506);

        assert_eq!(&frame[0..4], b"BA1F");
        assert_eq!(frame[4], FRAME_VERSION);
        assert_eq!(frame[5], PIXEL_FORMAT_RGBA8);
        assert_eq!(&frame[6..8], &[0, 0]);
        assert_eq!(u32::from_le_bytes(frame[8..12].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(frame[12..16].try_into().unwrap()), 1);
        assert_eq!(
            u64::from_le_bytes(frame[16..24].try_into().unwrap()),
            0x0102_0304_0506
        );
        assert_eq!(&frame[FRAME_HEADER_BYTES..], &pixels);
    }

    #[test]
    fn clip_shrinks_to_the_target_and_rejects_no_overlap() {
        let inside = clip(Rect { x: -10, y: 5, width: 100, height: 100 }, 50, 50).unwrap();
        assert_eq!((inside.x, inside.y, inside.width, inside.height), (0, 5, 50, 45));

        assert!(clip(Rect { x: 60, y: 0, width: 10, height: 10 }, 50, 50).is_err());
    }

    /// End-to-end grab against the real display. Ignored by default because it needs a
    /// live, unlocked session; run it locally with `cargo test -- --ignored`.
    #[test]
    #[ignore = "requires a live display"]
    fn captures_the_primary_monitor() {
        let targets = list_targets().expect("enumerate targets");
        let monitor = targets
            .iter()
            .find(|t| t.kind == TargetKind::Monitor && t.is_primary)
            .expect("a primary monitor");

        let frame = capture(&monitor.id, None, None, None).expect("full grab");
        assert_eq!(&frame[0..4], b"BA1F");
        let width = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
        let height = u32::from_le_bytes(frame[12..16].try_into().unwrap()) as usize;
        assert!(width > 0 && height > 0, "grabbed a {width}x{height} frame");
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + width * height * BYTES_PER_PIXEL);

        // A region grab must come back exactly the size asked for.
        let region = Rect { x: 0, y: 0, width: 64, height: 32 };
        let cropped = capture(&monitor.id, Some(region), None, None).expect("region grab");
        assert_eq!(cropped.len(), FRAME_HEADER_BYTES + 64 * 32 * BYTES_PER_PIXEL);

        // A capped grab must come back within the cap, and far smaller than the original.
        let capped = capture(&monitor.id, None, Some(640), None).expect("capped grab");
        let capped_width = u32::from_le_bytes(capped[8..12].try_into().unwrap());
        let capped_height = u32::from_le_bytes(capped[12..16].try_into().unwrap());
        assert!(capped_width <= 640 && capped_height <= 640, "got {capped_width}x{capped_height}");
        assert!(capped.len() < frame.len() / 8, "cap barely reduced the payload");
    }

    /// `source` must be **target-local**, whatever the target's position on the virtual
    /// desktop. A client on a display above the primary has a negative desktop origin, and
    /// leaking that into `source` produced regions that could never overlap the target.
    #[test]
    #[ignore = "requires a live display"]
    fn capture_source_is_target_local_not_desktop() {
        let targets = list_targets().expect("enumerate targets");
        // Prefer a window: those are the targets that sit at negative desktop origins.
        let target = targets
            .iter()
            .find(|t| t.kind == TargetKind::Window && !t.is_minimized && t.bounds.width > 200)
            .or_else(|| targets.iter().find(|t| t.kind == TargetKind::Monitor))
            .expect("some capturable target");

        let region = Rect { x: 10, y: 20, width: 64, height: 32 };
        let cropped = capture_pixels(&target.id, Some(region), None).expect("region grab");
        assert_eq!(
            (cropped.source.x, cropped.source.y, cropped.source.width, cropped.source.height),
            (10, 20, 64, 32),
            "source must echo the requested target-local region, target sits at ({}, {})",
            target.bounds.x,
            target.bounds.y,
        );

        // With no region, the origin is the target's own origin: always zero.
        let whole = capture_pixels(&target.id, None, Some(320)).expect("whole grab");
        assert_eq!((whole.source.x, whole.source.y), (0, 0));

        // Downsampling shrinks the sampled dimensions but not the area covered.
        assert!(
            whole.source.width >= whole.width && whole.source.height >= whole.height,
            "source {}x{} should cover at least the sampled {}x{}",
            whole.source.width,
            whole.source.height,
            whole.width,
            whole.height,
        );
    }

    #[test]
    fn downsample_leaves_small_frames_alone() {
        let pixels = vec![7u8; 4 * 4 * BYTES_PER_PIXEL];
        let (w, h, out) = downsample(4, 4, pixels.clone(), 8);
        assert_eq!((w, h), (4, 4));
        assert_eq!(out, pixels);
    }

    #[test]
    fn downsample_never_exceeds_the_cap_and_keeps_real_pixel_values() {
        // 4x2, each pixel tagged with its own index in the red channel.
        let mut pixels = Vec::new();
        for i in 0..8u8 {
            pixels.extend_from_slice(&[i, 0, 0, 255]);
        }

        let (w, h, out) = downsample(4, 2, pixels, 2);
        assert_eq!((w, h), (2, 1));
        // step 2: takes columns 0 and 2 of row 0 — originals, not blends.
        assert_eq!(out, vec![0, 0, 0, 255, 2, 0, 0, 255]);
    }

    #[test]
    fn downsample_rounds_up_so_odd_sizes_stay_within_the_cap() {
        let pixels = vec![1u8; 9 * 9 * BYTES_PER_PIXEL];
        let (w, h, out) = downsample(9, 9, pixels, 4);
        assert!(w <= 4 && h <= 4, "got {w}x{h}");
        assert_eq!(out.len(), w as usize * h as usize * BYTES_PER_PIXEL);
    }

    /// The IPC cliff is a hard limit, so exceeding the budget is a bug, not a nicety.
    #[test]
    fn fit_to_bytes_never_exceeds_the_budget() {
        for budget in [1_024usize, 64_000, 500_000, 1_500_000] {
            for (width, height) in [(3840u32, 2160u32), (5120, 2160), (800, 600), (1, 1)] {
                let pixels = vec![9u8; width as usize * height as usize * BYTES_PER_PIXEL];
                let (w, h, out) = fit_to_bytes(width, height, pixels, budget);

                let encoded = FRAME_HEADER_BYTES + out.len();
                assert!(
                    encoded <= budget.max(FRAME_HEADER_BYTES + BYTES_PER_PIXEL),
                    "{width}x{height} with budget {budget} produced {w}x{h} = {encoded} bytes"
                );
                assert_eq!(out.len(), w as usize * h as usize * BYTES_PER_PIXEL);
                assert!(w > 0 && h > 0, "degenerated to {w}x{h}");
            }
        }
    }

    #[test]
    fn fit_to_bytes_leaves_a_frame_that_already_fits_untouched() {
        let pixels = vec![4u8; 10 * 10 * BYTES_PER_PIXEL];
        let (w, h, out) = fit_to_bytes(10, 10, pixels.clone(), 1_000_000);
        assert_eq!((w, h), (10, 10));
        assert_eq!(out, pixels);
    }

    #[test]
    fn fit_to_bytes_keeps_real_pixel_values() {
        // 4x1 with distinguishable pixels; halving must return originals, not averages.
        let mut pixels = Vec::new();
        for i in 0..4u8 {
            pixels.extend_from_slice(&[i * 10, 0, 0, 255]);
        }
        let budget = FRAME_HEADER_BYTES + 2 * BYTES_PER_PIXEL;
        let (w, _, out) = fit_to_bytes(4, 1, pixels, budget);
        assert_eq!(w, 2);
        assert_eq!(out, vec![0, 0, 0, 255, 20, 0, 0, 255]);
    }

    #[test]
    fn downsample_treats_a_zero_cap_as_no_cap() {
        let pixels = vec![3u8; 2 * 2 * BYTES_PER_PIXEL];
        let (w, h, _) = downsample(2, 2, pixels, 0);
        assert_eq!((w, h), (2, 2));
    }

}
