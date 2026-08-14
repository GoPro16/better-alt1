import type { Rect } from "@better-alt1/core";
import { invoke } from "@tauri-apps/api/core";

/** RuneScape's inventory holds 28 slots; classically 4 columns by 7 rows. */
export const DEFAULT_COLUMNS = 4;
export const DEFAULT_ROWS = 7;
export const SLOT_COUNT = DEFAULT_COLUMNS * DEFAULT_ROWS;

/**
 * Slot pitch is slightly wider than tall on a real client — measured 94x80 on a 4K RS3
 * layout, ~1:1 on classic compact ones. Anchoring the shape search here instead of at
 * square keeps a 5-column inventory from being mistaken for a 6-column one when the
 * selection includes a little panel padding.
 */
const CELL_ASPECT = 1.1;

/**
 * The client reflows the inventory with the panel: 28 slots in anywhere from ~3 to ~7
 * columns, last row partial. Slot pitch is near-constant, so the shape is recoverable
 * from the selected region's aspect ratio: pick the column count whose implied cells are
 * closest to the known pitch. `columns * rows` can exceed 28 — the tail cells of the last
 * row are background and every consumer ignores indices past `SLOT_COUNT - 1`.
 */
export function detectShape(size: { width: number; height: number }) {
  let best = { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
  let bestScore = Number.POSITIVE_INFINITY;
  for (let columns = 2; columns <= 10; columns++) {
    const rows = Math.ceil(SLOT_COUNT / columns);
    const cellAspect = size.width / columns / (size.height / rows);
    const score = Math.abs(Math.log(cellAspect / CELL_ASPECT));
    if (score < bestScore) {
      bestScore = score;
      best = { columns, rows };
    }
  }
  return best;
}

export interface SlotGrid {
  region: Rect;
  columns: number;
  rows: number;
  /** Pixels trimmed from each cell edge, keeping slot borders out of the comparison. */
  inset: number;
}

export interface InventoryScan {
  /** Mean absolute luma deviation per cell interior, row-major. */
  detail: number[];
  occupied: boolean[];
  occupiedCount: number;
  freeCount: number;
}

/** Calibration-free: emptiness is flatness, no reference capture involved. */
export function inventoryScan(id: number, grid: SlotGrid, detailThreshold?: number) {
  return invoke<InventoryScan>("inventory_scan", {
    id,
    grid,
    detailThreshold: detailThreshold ?? null,
  });
}

const STORAGE_KEY = "better-alt1.inventory-watch";

export const MIN_SENSITIVITY = 2;
export const MAX_SENSITIVITY = 40;

/**
 * One flow: watch the whole inventory, alert the moment the armed slot fills. Items land
 * in order, so a slot near the end filling *is* the "nearly full" signal.
 */
export interface InventoryConfig {
  /** The feature switch; persisted so a watch left on resumes at the next launch. */
  enabled: boolean;
  inset: number;
  /** Interior detail (mean absolute luma deviation) above which a slot reads occupied.
   * Empty slots measure ~2 on an opaque interface; items 40+. */
  tolerance: number;
  /** Alert when free slots drop to this or below. Permanent residents (coin pouch, map)
   * always read occupied, so they account for themselves — no exclusions needed. */
  alertAtFree: number;
  sound: boolean;
  flash: boolean;
  /** Show the pinned highlight overlay over the game client. */
  overlay: boolean;
}

export const DEFAULT_INVENTORY_CONFIG: InventoryConfig = {
  enabled: false,
  inset: 2,
  tolerance: 10,
  // Two free slots is enough warning to tab back and start dropping.
  alertAtFree: 2,
  sound: true,
  flash: true,
  overlay: false,
};

export function clampSensitivity(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_INVENTORY_CONFIG.tolerance;
  return Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, Math.round(value)));
}

export function loadInventoryConfig(): InventoryConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_INVENTORY_CONFIG;
    const parsed = JSON.parse(raw) as Partial<InventoryConfig>;
    // Built field-by-field rather than spread, so keys from older versions (calibration
    // references, watch modes, armed slots) don't ride along and get re-saved forever.
    return {
      enabled: parsed.enabled ?? DEFAULT_INVENTORY_CONFIG.enabled,
      inset: parsed.inset ?? DEFAULT_INVENTORY_CONFIG.inset,
      tolerance: clampSensitivity(parsed.tolerance ?? DEFAULT_INVENTORY_CONFIG.tolerance),
      alertAtFree:
        parsed.alertAtFree !== undefined &&
        parsed.alertAtFree >= 0 &&
        parsed.alertAtFree < SLOT_COUNT
          ? Math.round(parsed.alertAtFree)
          : DEFAULT_INVENTORY_CONFIG.alertAtFree,
      sound: parsed.sound ?? DEFAULT_INVENTORY_CONFIG.sound,
      flash: parsed.flash ?? DEFAULT_INVENTORY_CONFIG.flash,
      overlay: parsed.overlay ?? DEFAULT_INVENTORY_CONFIG.overlay,
    };
  } catch {
    // Corrupt storage must never stop the app from opening.
    return DEFAULT_INVENTORY_CONFIG;
  }
}

export function saveInventoryConfig(config: InventoryConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
