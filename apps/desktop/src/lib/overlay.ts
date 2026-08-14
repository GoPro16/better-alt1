/**
 * Contract between the main window and the overlay window. Both webviews import this;
 * keep it free of anything window-specific so either entry can load it.
 */

export const OVERLAY_LABEL = "overlay";
export const OVERLAY_STATUS_EVENT = "inventory-status";

/**
 * Frame geometry, all physical px. The overlay window covers the watched region plus a
 * margin band; the frame stroke lives in that band, hugging the region's outside edge, so
 * no overlay pixel ever lands inside a compared slot interior (cells are inset ≥2px) and
 * the scan can never capture its own highlight.
 */
export const FRAME_MARGIN = 4;
export const FRAME_BORDER = 2;
/** Strip outside the frame holding the status chip — above the region, or below when the
 * region sits too close to the client's top edge. */
export const CHIP_BAND = 40;

/** The overlay dims itself when no status arrives for this long; main emits every second
 * while the overlay is enabled, so silence means main is gone or wedged. */
export const OVERLAY_STALE_MS = 5_000;

export interface OverlayStatus {
  watching: boolean;
  freeCount: number | undefined;
  occupied: boolean[] | undefined;
  alerting: boolean;
  /** Watched region size, physical px — drives the frame geometry. */
  region: { width: number; height: number } | undefined;
  /** Which side of the region the chip strip sits on. */
  chip: "top" | "bottom";
}
