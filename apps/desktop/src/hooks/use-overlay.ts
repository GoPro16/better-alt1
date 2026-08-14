import type { CaptureTarget, Rect } from "@better-alt1/core";
import { emitTo } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize, Window } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import {
  CHIP_BAND,
  FRAME_MARGIN,
  OVERLAY_LABEL,
  OVERLAY_STATUS_EVENT,
  type OverlayStatus,
} from "@/lib/overlay";

/** Heartbeat cadence. Also the missed-event fix: an overlay webview that finishes loading
 * after the first emit gets the next one within a second. */
const EMIT_INTERVAL_MS = 1_000;

/**
 * Main-window side of the overlay: owns the overlay window's geometry and visibility, and
 * pushes watch status to it. The window is placed exactly over the watched region (plus
 * the margin and chip bands) so the overlay can frame the region in the client; all
 * coordinates are physical virtual-desktop px — bounds and region already are, so there is
 * no DPI math here. The overlay itself only renders; it runs no capture loop.
 *
 * Every window call swallows failure: a broken overlay must never take the watch down.
 */
export function useOverlay({
  enabled,
  target,
  region,
  status,
}: {
  enabled: boolean;
  target: CaptureTarget | undefined;
  /** Watched region, target-local physical px. */
  region: Rect | undefined;
  status: Omit<OverlayStatus, "region" | "chip">;
}) {
  const windowRef = useRef<Window | null>(null);
  const shownRef = useRef(false);

  // The chip goes above the region unless that would poke past the client's top edge.
  const chip: OverlayStatus["chip"] =
    region && region.y < CHIP_BAND + FRAME_MARGIN ? "bottom" : "top";

  const statusRef = useRef<OverlayStatus>({ ...status, region: undefined, chip });
  statusRef.current = {
    ...status,
    region: region ? { width: region.width, height: region.height } : undefined,
    chip,
  };

  useEffect(() => {
    let cancelled = false;
    void Window.getByLabel(OVERLAY_LABEL)
      .then((overlay) => {
        if (!cancelled) windowRef.current = overlay;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const visible =
    enabled && target !== undefined && !target.isMinimized && region !== undefined;
  const bounds = target?.bounds;
  // Depend on geometry values, not object identity — bounds is rebuilt every enumeration.
  const geometryKey =
    bounds && region
      ? `${bounds.x + region.x},${bounds.y + region.y},${region.width},${region.height},${chip}`
      : "";

  // Cover the region plus the margin and chip bands. Positioned and sized before show()
  // so the frame never flashes at a stale spot.
  useEffect(() => {
    const overlay = windowRef.current;
    if (!overlay || !visible || !geometryKey) return;
    const [x, y, width, height, side] = geometryKey.split(",");
    const regionX = Number(x);
    const regionY = Number(y);
    const regionW = Number(width);
    const regionH = Number(height);
    void overlay
      .setPosition(
        new PhysicalPosition(
          regionX - FRAME_MARGIN,
          regionY - FRAME_MARGIN - (side === "top" ? CHIP_BAND : 0),
        ),
      )
      .then(() =>
        overlay.setSize(
          new PhysicalSize(regionW + 2 * FRAME_MARGIN, regionH + 2 * FRAME_MARGIN + CHIP_BAND),
        ),
      )
      .then(() => {
        if (!shownRef.current) {
          shownRef.current = true;
          return overlay.show();
        }
        return undefined;
      })
      .catch(() => undefined);
  }, [visible, geometryKey]);

  useEffect(() => {
    if (visible) return;
    const overlay = windowRef.current;
    if (!overlay || !shownRef.current) return;
    shownRef.current = false;
    void overlay.hide().catch(() => undefined);
  }, [visible]);

  // Hide on unmount, whatever state we were in — a frozen frame floating over the game
  // reads as a bug.
  useEffect(
    () => () => {
      shownRef.current = false;
      void windowRef.current?.hide().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const emit = () =>
      void emitTo(OVERLAY_LABEL, OVERLAY_STATUS_EVENT, statusRef.current).catch(() => undefined);
    emit();
    const timer = setInterval(emit, EMIT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);
}
