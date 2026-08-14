pub mod analyze;
pub mod capture;
pub mod detect;
pub mod error;
pub mod inventory;
pub mod store;

use std::io::Cursor;

use analyze::{Point, Template};
use capture::{CaptureTarget, Rect};
use detect::DetectedGrid;
use error::{AppError, AppResult};
use inventory::{InventoryScan, SlotGrid};
use store::{FrameHandle, FrameStore};
use tauri::{Manager, State};

/// Ceiling on a raw region read. Well under the measured IPC cliff (see `capture.rs`);
/// anything larger should be answered by an analysis command instead of shipped.
const MAX_REGION_BYTES: usize = 1_000_000;

/// Upper bound for `ipc_benchmark`, so a typo cannot ask for a gigabyte.
const MAX_BENCHMARK_BYTES: usize = 32 * 1024 * 1024;

/// Enumeration touches every window handle, so keep it off the UI thread too.
#[tauri::command]
async fn list_capture_targets() -> AppResult<Vec<CaptureTarget>> {
    blocking(capture::list_targets).await
}

/// Capture into native memory and return only a handle.
///
/// This is the primary capture entry point. Nothing here transfers pixels: the frontend
/// gets an id plus dimensions and then asks questions with the `frame_*` commands. See
/// `store.rs` for why.
#[tauri::command]
async fn capture_frame_handle(
    store: State<'_, FrameStore>,
    target_id: String,
    region: Option<Rect>,
    max_dimension: Option<u32>,
) -> AppResult<FrameHandle> {
    let grabbed =
        blocking(move || capture::capture_pixels(&target_id, region, max_dimension)).await?;

    // `source` comes from the capture itself, in target-local coordinates. The frontend
    // uses it to map preview coordinates back to the target rather than guessing — a guess
    // there produced regions offset by the window's virtual-desktop origin.
    Ok(store.insert(
        grabbed.width,
        grabbed.height,
        grabbed.captured_at,
        grabbed.source,
        grabbed.pixels,
    ))
}

/// PNG-encode a stored frame for display.
///
/// PNG rather than raw: a full-resolution 800x600 region is ~300 KB encoded against
/// 1.83 MiB raw, which keeps it comfortably inside the transport's fast path and removes
/// any need to downscale the preview. Lossless, so the pixel probe stays truthful.
#[tauri::command]
async fn frame_png(store: State<'_, FrameStore>, id: u64) -> AppResult<tauri::ipc::Response> {
    let raw = store
        .with(id, |frame| (frame.width, frame.height, frame.pixels.clone()))
        .ok_or(AppError::UnknownFrame(id))?;

    let (width, height, pixels) = raw;
    let encoded = blocking(move || encode_png(width, height, pixels)).await?;
    Ok(tauri::ipc::Response::new(encoded))
}

fn encode_png(width: u32, height: u32, pixels: Vec<u8>) -> AppResult<Vec<u8>> {
    let image = xcap::image::RgbaImage::from_raw(width, height, pixels)
        .ok_or(AppError::MalformedFrame { width, height })?;

    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, xcap::image::ImageFormat::Png)
        .map_err(|err| AppError::Encode(err.to_string()))?;
    Ok(out.into_inner())
}

/// Single pixel as packed 0xAARRGGBB. The cheapest possible question.
#[tauri::command]
fn frame_pixel(store: State<'_, FrameStore>, id: u64, x: u32, y: u32) -> AppResult<Option<u32>> {
    store
        .with(id, |frame| analyze::pixel_at(frame, x, y))
        .ok_or(AppError::UnknownFrame(id))
}

/// Raw RGBA for a small region. Guarded, because this is the one command that can move
/// real volume and so is the one that can reintroduce the stall.
#[tauri::command]
fn frame_region(
    store: State<'_, FrameStore>,
    id: u64,
    region: Rect,
) -> AppResult<tauri::ipc::Response> {
    let requested = region.width as usize * region.height as usize * 4;
    if requested > MAX_REGION_BYTES {
        return Err(AppError::RegionTooLarge { requested, limit: MAX_REGION_BYTES });
    }

    let pixels = store
        .with(id, |frame| match analyze::clamp_to_frame(frame, region) {
            Some(clamped) => Ok(analyze::copy_region(frame, clamped)),
            None => Err(AppError::RegionOutOfBounds {
                region,
                width: frame.width,
                height: frame.height,
            }),
        })
        .ok_or(AppError::UnknownFrame(id))??;

    Ok(tauri::ipc::Response::new(pixels))
}

/// Content fingerprint, so callers can skip work when nothing changed.
#[tauri::command]
fn frame_signature(
    store: State<'_, FrameStore>,
    id: u64,
    region: Option<Rect>,
    samples: Option<usize>,
) -> AppResult<u32> {
    store
        .with(id, |frame| analyze::signature(frame, region, samples.unwrap_or(4096)))
        .ok_or(AppError::UnknownFrame(id))
}

/// Template match, run natively. Returns coordinates, not pixels.
#[tauri::command]
async fn frame_find_subimage(
    store: State<'_, FrameStore>,
    id: u64,
    template: Template,
    region: Option<Rect>,
    tolerance: Option<u8>,
    max_matches: Option<usize>,
) -> AppResult<Vec<Point>> {
    if !template.is_valid() {
        return Err(AppError::MalformedTemplate {
            width: template.width,
            height: template.height,
            len: template.pixels.len(),
        });
    }

    store
        .with(id, |frame| {
            analyze::find_subimage(
                frame,
                &template,
                region,
                tolerance.unwrap_or(0),
                max_matches.unwrap_or(16),
            )
        })
        .ok_or(AppError::UnknownFrame(id))
}

#[tauri::command]
fn frame_release(store: State<'_, FrameStore>, id: u64) -> bool {
    store.release(id)
}

/// Find the inventory slot grid in a frame, no user drag required. Walks the whole frame
/// natively (a 4K frame takes ~150ms), so the work runs on the blocking pool — the
/// pixels are copied out first rather than holding the store lock that long. `None`
/// simply means "not confident" — the caller falls back to manual selection, never to a
/// guess.
#[tauri::command]
async fn frame_detect_slots(
    store: State<'_, FrameStore>,
    id: u64,
) -> AppResult<Option<DetectedGrid>> {
    let (width, height, pixels) = store
        .with(id, |frame| (frame.width, frame.height, frame.pixels.clone()))
        .ok_or(AppError::UnknownFrame(id))?;

    blocking(move || Ok(detect::detect_slots(width, height, &pixels))).await
}

/// Read the inventory grid: per-cell interior detail and the occupancy it implies. No
/// reference or calibration involved — flatness is the emptiness signal.
///
/// Returns a few hundred bytes for a 28-slot inventory — the entire point of doing the
/// grid work natively rather than shipping the pixels and slicing them in JavaScript.
#[tauri::command]
fn inventory_scan(
    store: State<'_, FrameStore>,
    id: u64,
    grid: SlotGrid,
    detail_threshold: Option<u8>,
) -> AppResult<InventoryScan> {
    if !grid.is_valid() {
        return Err(AppError::InvalidGrid {
            columns: grid.columns,
            rows: grid.rows,
            width: grid.region.width,
            height: grid.region.height,
        });
    }

    let threshold = detail_threshold.unwrap_or(inventory::DEFAULT_DETAIL_THRESHOLD);
    store
        .with(id, |frame| inventory::scan(frame, &grid, threshold))
        .ok_or(AppError::UnknownFrame(id))
}

/// Returns `bytes` of filler so the frontend can measure IPC throughput on its own,
/// with no capture involved.
///
/// Exists because "the app is slow" was repeatedly misattributed to screen capture when
/// capture was measured at 24ms. Isolating the transport is the only way to tell the two
/// apart. The payload is not zeroed — an all-zero buffer is exactly the thing a
/// compressing or sparse transport would optimise away, hiding the real cost.
#[tauri::command]
async fn ipc_benchmark(bytes: usize) -> AppResult<tauri::ipc::Response> {
    let len = bytes.min(MAX_BENCHMARK_BYTES);
    let filler: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
    Ok(tauri::ipc::Response::new(filler))
}

/// Run blocking work on the blocking pool and flatten the join error.
async fn blocking<T, F>(work: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(join_error) => Err(AppError::Worker(join_error.to_string())),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(FrameStore::new());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Tauri only exits once every window is gone, and the hidden overlay window
            // would otherwise keep the process alive after the user closes the app.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_capture_targets,
            capture_frame_handle,
            frame_png,
            frame_pixel,
            frame_region,
            frame_signature,
            frame_find_subimage,
            frame_release,
            frame_detect_slots,
            inventory_scan,
            ipc_benchmark
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the better-alt1 window");
}
