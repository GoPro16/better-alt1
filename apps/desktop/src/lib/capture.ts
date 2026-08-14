import type { CaptureTarget, Point, Rect } from "@better-alt1/core";
import type { FrameHandle, FindOptions, Template } from "@better-alt1/plugin-sdk";
import { invoke } from "@tauri-apps/api/core";

/**
 * Ceiling on a raw region read, mirroring `MAX_REGION_BYTES` in the backend.
 *
 * The transport has a hard cliff: 512 KiB round trips in ~11ms while 2 MiB and 4 MiB both
 * cost ~4.1 *seconds* — a fixed penalty, not a bandwidth limit, and it blocks the UI
 * thread. Anything bigger than this should be answered by an analysis command instead of
 * transferred. Re-measure with "test IPC alone" before raising it.
 */
export const MAX_REGION_BYTES = 1_000_000;

export function listCaptureTargets() {
  return invoke<CaptureTarget[]>("list_capture_targets");
}

/**
 * True when a capture failed because the target id no longer exists — the one failure
 * re-enumerating can fix. Matches `AppError::UnknownTarget` in `src-tauri/src/error.rs`,
 * which reaches JS as a plain string; the other capture errors (minimised, off-screen)
 * mean the target is still there and re-enumerating would change nothing.
 */
export function isUnknownTargetError(cause: unknown) {
  return String(cause).includes("no capture target with id");
}

export interface CaptureOptions {
  /** Target-local region. Clipped by the backend; omit for the whole target. */
  region?: Rect;
  /** Cap on the longest side, applied before the frame is stored. */
  maxDimension?: number;
}

/**
 * Capture into native memory and get back a handle — no pixels cross the boundary.
 *
 * Rejects when the grab fails, which is routine: minimised windows, sleeping displays.
 */
export function captureFrame(
  targetId: string,
  { region, maxDimension }: CaptureOptions = {},
): Promise<FrameHandle> {
  return invoke<FrameHandle>("capture_frame_handle", {
    targetId,
    region: region ?? null,
    maxDimension: maxDimension ?? null,
  });
}

/**
 * PNG bytes for display. Lossless, and far smaller than raw — a full-resolution 800x600
 * region is ~300 KB encoded against 1.83 MiB raw, which keeps it inside the transport's
 * fast path without downscaling the preview.
 */
export async function framePng(id: number): Promise<Uint8Array> {
  const payload = await invoke<ArrayBuffer | Uint8Array>("frame_png", { id });
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

export function framePixel(id: number, x: number, y: number) {
  return invoke<number | null>("frame_pixel", { id, x, y });
}

/** Named to avoid colliding with `frameSignature` in `@better-alt1/core`, which works on
 * decoded pixels in JS; this one runs natively against a handle. */
export function frameHandleSignature(id: number, region?: Rect, samples?: number) {
  return invoke<number>("frame_signature", {
    id,
    region: region ?? null,
    samples: samples ?? null,
  });
}

export function frameFindSubimage(id: number, template: Template, options: FindOptions = {}) {
  return invoke<Point[]>("frame_find_subimage", {
    id,
    template: {
      width: template.width,
      height: template.height,
      // Tauri serialises a typed array as a JSON number array; templates are small.
      pixels: Array.from(template.pixels),
      alphaThreshold: template.alphaThreshold ?? 1,
    },
    region: options.region ?? null,
    tolerance: options.tolerance ?? null,
    maxMatches: options.maxMatches ?? null,
  });
}

/** The auto-found inventory grid, or null when the detector is not confident. */
export interface DetectedGrid {
  region: Rect;
  columns: number;
  rows: number;
}

/** Locate the inventory slot grid in a frame natively — no user drag required. */
export function frameDetectSlots(id: number) {
  return invoke<DetectedGrid | null>("frame_detect_slots", { id });
}

export async function frameRegion(id: number, region: Rect): Promise<Uint8Array> {
  const payload = await invoke<ArrayBuffer | Uint8Array>("frame_region", { id, region });
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

export function frameRelease(id: number) {
  return invoke<boolean>("frame_release", { id });
}
