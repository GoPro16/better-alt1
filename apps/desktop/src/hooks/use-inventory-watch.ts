import type { Rect } from "@better-alt1/core";
import { cursorPosition } from "@tauri-apps/api/window";
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
  /** The target's virtual-desktop bounds — needed to map the OS cursor into the frame
   * so the slot under it can be held (see cursorMaskedSlots). */
  targetBounds: Rect | undefined;
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
  targetBounds,
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
  // Settled occupancy and the last raw read, for hysteresis (see settleSlots).
  const acceptedRef = useRef<boolean[] | undefined>(undefined);
  const pendingRef = useRef<boolean[] | undefined>(undefined);
  // Read inside the tick without re-running the effect when enumeration refreshes it —
  // bounds only move when the client window moves, and a one-tick lag there is harmless.
  const targetBoundsRef = useRef(targetBounds);
  targetBoundsRef.current = targetBounds;

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

    // A new region or grid shape is a new watch — settle from scratch.
    acceptedRef.current = undefined;
    pendingRef.current = undefined;

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
        const raw = result.occupied.slice(0, SLOT_COUNT);

        // The RS3 client draws its own cursor into the framebuffer, so hovering a slot
        // adds interior detail that reads as an item. Hold the slot(s) under the cursor
        // at their last settled state instead of trusting this read.
        const masked = await cursorMaskedSlots({
          targetBounds: targetBoundsRef.current,
          region: parsed,
          frameWidth: handle.width,
          frameHeight: handle.height,
          columns,
          rows,
        });
        const slots = settleSlots(raw, masked, acceptedRef, pendingRef);
        if (cancelled) return;

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

/** Cursor sprite extent past its hotspot, in physical pixels. The RS3 cursor hangs
 * down-right, plus a little slack on the other sides for the hotspot inset. */
const CURSOR_PAD = 28;

/**
 * Which slot indices the OS cursor currently overlaps, in frame-grid terms. Reading the
 * cursor is passive observation — the compliance line is *moving* it. Any failure means
 * "mask nothing": worse detection for one tick beats a dead watch loop.
 */
async function cursorMaskedSlots(args: {
  targetBounds: Rect | undefined;
  region: Rect;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
}): Promise<Set<number>> {
  const { targetBounds, region, frameWidth, frameHeight, columns, rows } = args;
  const masked = new Set<number>();
  if (!targetBounds) return masked;

  let cursor;
  try {
    cursor = await cursorPosition();
  } catch {
    return masked;
  }

  // Virtual desktop -> target-local -> region-local, then into frame pixels (the frame
  // can be a decimated copy of the region, so scale rather than assume 1:1).
  const rx = cursor.x - targetBounds.x - region.x;
  const ry = cursor.y - targetBounds.y - region.y;
  const scaleX = frameWidth / region.width;
  const scaleY = frameHeight / region.height;
  const cellWidth = frameWidth / columns;
  const cellHeight = frameHeight / rows;

  for (const dx of [-4, CURSOR_PAD]) {
    for (const dy of [-4, CURSOR_PAD]) {
      const column = Math.floor(((rx + dx) * scaleX) / cellWidth);
      const row = Math.floor(((ry + dy) * scaleY) / cellHeight);
      if (column < 0 || column >= columns || row < 0 || row >= rows) continue;
      const index = row * columns + column;
      if (index < SLOT_COUNT) masked.add(index);
    }
  }
  return masked;
}

/**
 * Per-slot hysteresis: a slot only changes state after two consecutive reads agree on
 * the new value, and masked (cursor-covered) slots hold their settled state outright.
 * Catches the cursor transiting between ticks and the hover tooltip shading a slot the
 * mask misses, at the cost of one poll interval of latency on real changes.
 */
function settleSlots(
  raw: boolean[],
  masked: Set<number>,
  acceptedRef: { current: boolean[] | undefined },
  pendingRef: { current: boolean[] | undefined },
): boolean[] {
  const accepted = acceptedRef.current;
  if (accepted === undefined || accepted.length !== raw.length) {
    // First read of a watch: trust it, so startup shows state immediately.
    acceptedRef.current = [...raw];
    pendingRef.current = [...raw];
    return raw;
  }

  const pending = pendingRef.current ?? [...raw];
  const settled = raw.map((value, i) => {
    if (masked.has(i) || value === accepted[i]) {
      pending[i] = accepted[i] as boolean;
      return accepted[i] as boolean;
    }
    if (pending[i] === value) return value; // second consecutive read agreeing — flip
    pending[i] = value;
    return accepted[i] as boolean;
  });

  acceptedRef.current = settled;
  pendingRef.current = pending;
  return settled;
}

function parseRegionKey(key: string): Rect | undefined {
  if (!key) return undefined;
  const [x, y, width, height] = key.split(",").map(Number);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}
