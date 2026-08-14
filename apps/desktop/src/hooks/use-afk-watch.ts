import { useEffect, useState } from "react";
import type { AfkConfig } from "@/lib/afk";
import { createAlertGate, raiseAlert } from "@/lib/alert";
import { captureFrame, frameHandleSignature, frameRelease } from "@/lib/capture";

export interface AfkWatchState {
  /** How long the watched region has been unchanged. Undefined until the first reading. */
  idleForMs: number | undefined;
  /** True while idle time exceeds the configured threshold. */
  alerting: boolean;
  lastScanMs: number | undefined;
  error: string | undefined;
}

interface WatchOptions {
  targetId: string | undefined;
  config: AfkConfig;
  enabled: boolean;
  intervalMs: number;
  /** Wire to `useResolvedTarget().reportCaptureError` so a stale target id heals. */
  onCaptureError?: (cause: unknown) => void;
}

/**
 * The idle alarm: polls the watched region's native signature — a 4-byte answer to "did
 * anything change?" — and alerts when it has been static for the configured time. No
 * pixels cross the IPC boundary.
 */
export function useAfkWatch({
  targetId,
  config,
  enabled,
  intervalMs,
  onCaptureError,
}: WatchOptions): AfkWatchState {
  const [idleForMs, setIdleForMs] = useState<number>();
  const [alerting, setAlerting] = useState(false);
  const [lastScanMs, setLastScanMs] = useState<number>();
  const [error, setError] = useState<string>();

  const { region, idleAfterSeconds, sound, flash } = config;
  const regionKey = region ? `${region.x},${region.y},${region.width},${region.height}` : "";

  useEffect(() => {
    if (!enabled || !targetId || !regionKey) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Baseline state lives inside the effect: enabling, retargeting, or moving the region
    // starts a fresh observation rather than inheriting a stale "idle for 40s".
    let lastSignature: number | undefined;
    let lastChangeAt = performance.now();
    const gate = createAlertGate();

    const parsed = parseRegionKey(regionKey);

    const tick = async () => {
      const started = performance.now();
      try {
        const handle = await captureFrame(targetId, { region: parsed });
        let signature: number;
        try {
          signature = await frameHandleSignature(handle.id);
        } finally {
          void frameRelease(handle.id).catch(() => undefined);
        }
        if (cancelled) return;

        const now = performance.now();
        if (lastSignature === undefined || signature !== lastSignature) {
          lastSignature = signature;
          lastChangeAt = now;
        }

        const idle = Math.round(now - lastChangeAt);
        setIdleForMs(idle);
        setLastScanMs(Math.round(now - started));
        setError(undefined);

        const crossed = idle >= idleAfterSeconds * 1000;
        setAlerting(crossed);
        if (gate(crossed, now)) void raiseAlert({ sound, flash });
      } catch (cause) {
        if (!cancelled) {
          setError(String(cause));
          onCaptureError?.(cause);
        }
      }

      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, targetId, regionKey, idleAfterSeconds, sound, flash, intervalMs, onCaptureError]);

  // Clear the readout when the loop stops, so a re-enable starts visibly fresh.
  useEffect(() => {
    if (enabled) return;
    setAlerting(false);
    setIdleForMs(undefined);
    setLastScanMs(undefined);
    setError(undefined);
  }, [enabled]);

  return { idleForMs, alerting, lastScanMs, error };
}

function parseRegionKey(key: string) {
  const [x, y, width, height] = key.split(",").map(Number);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}
