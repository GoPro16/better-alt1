import type { Rect } from "@better-alt1/core";
import { useEffect, useRef, useState } from "react";
import { createAlertGate, raiseAlert } from "@/lib/alert";
import { captureFrame, frameRelease } from "@/lib/capture";
import {
  type InventoryConfig,
  type SlotGrid,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  SLOT_COUNT,
  detectShape,
  inventoryScan,
} from "@/lib/inventory";

export interface InventoryWatchState {
  /** Grid shape detected from the region's aspect ratio (client reflows the inventory). */
  columns: number;
  rows: number;
  freeCount: number | undefined;
  occupied: boolean[] | undefined;
  /** True while free slots are at or below the configured threshold. */
  alerting: boolean;
  /** Milliseconds since the slot occupancy last changed — an idle timer, effectively. */
  unchangedForMs: number | undefined;
  lastScanMs: number | undefined;
  error: string | undefined;
}

interface WatchOptions {
  targetId: string | undefined;
  region: Rect | undefined;
  config: InventoryConfig;
  enabled: boolean;
  intervalMs: number;
  /** Receives every capture failure; wire to `useResolvedTarget().reportCaptureError` so
   * a stale target id heals by re-enumeration instead of erroring forever. */
  onCaptureError?: (cause: unknown) => void;
}

/**
 * Polls the inventory region and alerts as it fills. Calibration-free: the scan reads
 * emptiness from cell-interior flatness natively; only occupancy booleans and per-cell
 * detail numbers cross the IPC boundary — never pixels.
 */
export function useInventoryWatch({
  targetId,
  region,
  config,
  enabled,
  intervalMs,
  onCaptureError,
}: WatchOptions): InventoryWatchState {
  const [freeCount, setFreeCount] = useState<number>();
  const [occupied, setOccupied] = useState<boolean[]>();
  const [alerting, setAlerting] = useState(false);
  const [unchangedForMs, setUnchangedForMs] = useState<number>();
  const [lastScanMs, setLastScanMs] = useState<number>();
  const [error, setError] = useState<string>();

  // Alerting is edge-triggered with a periodic repeat; the gate survives renders and is
  // recreated when watching stops, so re-enabling re-alerts rather than staying quiet.
  const gateRef = useRef(createAlertGate());
  const lastChangeAtRef = useRef(performance.now());
  const lastOccupancyRef = useRef<string>("");

  const regionKey = region ? `${region.x},${region.y},${region.width},${region.height}` : "";
  const { inset, tolerance, alertAtFree, sound, flash } = config;
  // The client reflows the inventory with its panel; the region's aspect tells us the
  // column count. The grid may carry tail cells past slot 28 — sliced off below.
  const { columns, rows } = region
    ? detectShape(region)
    : { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };

  useEffect(() => {
    if (!enabled || !targetId || !regionKey) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parsed = parseRegionKey(regionKey);

    const tick = async () => {
      const started = performance.now();
      try {
        if (!parsed) throw new Error("set a capture region over your inventory first");

        const handle = await captureFrame(targetId, { region: parsed });
        let result;
        try {
          const grid: SlotGrid = {
            // The frame *is* the region, so the grid covers all of it.
            region: { x: 0, y: 0, width: handle.width, height: handle.height },
            columns,
            rows,
            inset,
          };
          result = await inventoryScan(handle.id, grid, tolerance);
        } finally {
          void frameRelease(handle.id).catch(() => undefined);
        }
        if (cancelled) return;

        // The grid may include background cells past slot 28 (partial last row on wide
        // layouts); everything downstream sees real slots only.
        const slots = result.occupied.slice(0, SLOT_COUNT);

        setOccupied(slots);
        setLastScanMs(Math.round(performance.now() - started));
        setError(undefined);

        const free = slots.filter((filled) => !filled).length;
        setFreeCount(free);

        // Track when occupancy last changed; a stalled inventory is itself informative.
        const fingerprint = slots.map((filled) => (filled ? "1" : "0")).join("");
        if (fingerprint !== lastOccupancyRef.current) {
          lastOccupancyRef.current = fingerprint;
          lastChangeAtRef.current = performance.now();
        }
        setUnchangedForMs(Math.round(performance.now() - lastChangeAtRef.current));

        // Free count crossing the threshold is the alert.
        const crossed = free <= alertAtFree;
        setAlerting(crossed);
        if (gateRef.current(crossed, performance.now())) void raiseAlert({ sound, flash });
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
  }, [
    enabled,
    targetId,
    regionKey,
    columns,
    rows,
    inset,
    tolerance,
    alertAtFree,
    sound,
    flash,
    intervalMs,
    onCaptureError,
  ]);

  // Reset alert state when watching stops, so re-enabling re-alerts rather than staying quiet.
  useEffect(() => {
    if (enabled) return;
    setAlerting(false);
    gateRef.current = createAlertGate();
  }, [enabled]);

  return { columns, rows, freeCount, occupied, alerting, unchangedForMs, lastScanMs, error };
}

function parseRegionKey(key: string): Rect | undefined {
  if (!key) return undefined;
  const [x, y, width, height] = key.split(",").map(Number);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}
