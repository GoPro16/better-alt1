import { type CaptureTarget, type Rect, rankTargets } from "@better-alt1/core";
import type { FrameHandle } from "@better-alt1/plugin-sdk";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { decodePng } from "@/lib/canvas";
import {
  captureFrame,
  frameHandleSignature,
  framePng,
  frameRelease,
  listCaptureTargets,
} from "@/lib/capture";

export const captureTargetsKey = ["capture", "targets"] as const;

/** Enumerated monitors and windows, game clients ranked first. */
export function useCaptureTargets(options: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: captureTargetsKey,
    queryFn: async () => rankTargets(await listCaptureTargets()),
    refetchInterval: options.refetchInterval ?? false,
  });
}

/** Cap on the longest side of a previewed frame. */
export const PREVIEW_MAX_DIMENSION = 1600;

/**
 * Idle time after a grab, as a multiple of how long that grab took. `2` means capture
 * never occupies more than a third of wall-clock, whatever the requested interval.
 */
const MIN_IDLE_RATIO = 2;

/**
 * How often measurements are published to React.
 *
 * Metrics update on every frame but are only *rendered* at this rate. Publishing each one
 * as it changes meant many state updates per frame, re-rendering the target dropdown and
 * every stat row along with the canvas — the app fighting itself while capturing.
 */
const STATS_PUBLISH_MS = 250;

export interface FrameStats {
  fps: number;
  frameCount: number;
  signature: number | undefined;
  /**
   * Consecutive frames with identical content. Non-zero means capture is working and the
   * screen region genuinely is not changing — which looks exactly like a broken preview.
   */
  staleFrames: number;
  lastGrabMs: number | undefined;
  worstGrabMs: number;
  /** Native grab, before anything is encoded or transferred. */
  worstCaptureMs: number;
  /** PNG encode plus transfer plus bitmap decode. */
  worstPreviewMs: number;
  /** Size of the encoded preview, versus the native frame it came from. */
  previewKib: number;
  nativeKib: number;
}

const EMPTY_STATS: FrameStats = {
  fps: 0,
  frameCount: 0,
  signature: undefined,
  staleFrames: 0,
  lastGrabMs: undefined,
  worstGrabMs: 0,
  worstCaptureMs: 0,
  worstPreviewMs: 0,
  previewKib: 0,
  nativeKib: 0,
};

export interface FrameStream {
  /** The newest decoded preview, ready to draw. */
  bitmap: ImageBitmap | undefined;
  /** Metadata for the newest frame. Pixels stay in Rust. */
  handle: FrameHandle | undefined;
  error: string | undefined;
  stats: FrameStats;
  grabOnce: () => void;
}

/**
 * Drives capture on an interval when `live`, or on demand.
 *
 * Pixels never reach JavaScript: capture returns a handle, and the preview is a
 * separately-encoded PNG. Analysis should use the `frame_*` commands against the handle
 * rather than pulling pixels here.
 */
export function useFrameStream(
  target: CaptureTarget | undefined,
  options: { live: boolean; intervalMs: number; region?: Rect; maxDimension?: number },
): FrameStream {
  const { live, intervalMs, region, maxDimension = PREVIEW_MAX_DIMENSION } = options;
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  const [handle, setHandle] = useState<FrameHandle>();
  const [error, setError] = useState<string>();
  const [stats, setStats] = useState<FrameStats>(EMPTY_STATS);

  // Hot path writes here; a timer publishes snapshots. Refs so recording a measurement
  // never schedules a render.
  const statsRef = useRef<FrameStats>(EMPTY_STATS);
  const deliveredRef = useRef(0);
  const fpsWindowStartRef = useRef(0);
  // Bitmaps hold GPU memory until closed, so the previous one must be released.
  const bitmapRef = useRef<ImageBitmap | undefined>(undefined);

  const targetId = target?.id;
  // Depend on the region's values, not its identity, so an inline object is safe.
  const regionKey = region ? `${region.x},${region.y},${region.width},${region.height}` : "";

  const grab = useCallback(async (): Promise<number> => {
    if (!targetId) return 0;
    const started = performance.now();

    try {
      const next = await captureFrame(targetId, {
        region: parseRegionKey(regionKey),
        maxDimension,
      });
      const captured = performance.now();

      // Signature is computed natively, so "did anything change?" costs 4 bytes.
      const signature = await frameHandleSignature(next.id);

      const png = await framePng(next.id);
      const decoded = await decodePng(png);
      const ready = performance.now();

      // The frame has served its purpose for the preview; analysis would hold it longer.
      void frameRelease(next.id).catch(() => undefined);

      bitmapRef.current?.close();
      bitmapRef.current = decoded;

      const previous = statsRef.current;
      statsRef.current = {
        ...previous,
        frameCount: previous.frameCount + 1,
        signature,
        staleFrames: signature === previous.signature ? previous.staleFrames + 1 : 0,
        worstCaptureMs: Math.max(previous.worstCaptureMs, Math.round(captured - started)),
        worstPreviewMs: Math.max(previous.worstPreviewMs, Math.round(ready - captured)),
        previewKib: Math.round(png.byteLength / 1024),
        nativeKib: Math.round(next.byteLen / 1024),
      };
      deliveredRef.current += 1;

      setBitmap(decoded);
      setHandle(next);
      setError(undefined);
    } catch (cause) {
      setError(String(cause));
    }

    const elapsed = Math.round(performance.now() - started);
    statsRef.current = {
      ...statsRef.current,
      lastGrabMs: elapsed,
      worstGrabMs: Math.max(statsRef.current.worstGrabMs, elapsed),
    };
    return elapsed;
  }, [targetId, regionKey, maxDimension]);

  useEffect(() => {
    statsRef.current = EMPTY_STATS;
    deliveredRef.current = 0;
    fpsWindowStartRef.current = performance.now();
    setStats(EMPTY_STATS);
    setBitmap(undefined);
    setHandle(undefined);
    setError(undefined);
  }, [targetId]);

  // Release the last bitmap on unmount; GPU memory is not garbage collected for us.
  useEffect(
    () => () => {
      bitmapRef.current?.close();
      bitmapRef.current = undefined;
    },
    [],
  );

  // Publish measurements at a fixed, low rate regardless of frame rate.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const windowMs = now - fpsWindowStartRef.current;
      if (windowMs >= 1000) {
        statsRef.current = {
          ...statsRef.current,
          fps: Math.round((deliveredRef.current / windowMs) * 1000),
        };
        deliveredRef.current = 0;
        fpsWindowStartRef.current = now;
      }
      setStats(statsRef.current);
    }, STATS_PUBLISH_MS);

    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!live || !targetId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Self-pacing, duty-cycle limited. Waits `intervalMs` *after* a grab finishes rather
     * than firing on a fixed schedule, and never spends more than a third of wall-clock
     * capturing — back-to-back 4K readbacks starve the compositor.
     */
    const loop = async () => {
      const took = await grab();
      if (cancelled) return;
      timer = setTimeout(() => void loop(), Math.max(intervalMs, took * MIN_IDLE_RATIO));
    };

    void loop();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [live, targetId, intervalMs, grab]);

  return { bitmap, handle, error, stats, grabOnce: () => void grab() };
}

function parseRegionKey(key: string): Rect | undefined {
  if (!key) return undefined;
  const [x, y, width, height] = key.split(",").map(Number);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}
