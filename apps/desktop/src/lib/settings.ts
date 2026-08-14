import type { Rect, TargetDescriptor } from "@better-alt1/core";

const STORAGE_KEY = "better-alt1.capture-settings";

/** Fired on every save so other hook instances — and non-React modules like the sound
 * engine — can re-read. One renderer process, so a window event is enough. */
export const SETTINGS_CHANGED_EVENT = "better-alt1:settings-changed";

export type AlertTone = "bell" | "chime" | "horn";

export const UI_SCALES = [0.9, 1, 1.15, 1.3] as const;

/**
 * Bumped when the meaning of a stored field changes. Version 2: `region` must cover the
 * whole inventory slot grid — earlier versions stored a single-slot box, which every
 * later feature silently mis-read (the scan said "28 free" forever and the overlay framed
 * a stale spot). Loading an older blob drops the region so setup asks again.
 */
const SETTINGS_VERSION = 2;

export interface CaptureSettings {
  /** Delay between grabs while live capture is on. */
  intervalMs: number;
  /** Restrict capture to this target-local region, or capture the whole target. */
  region: Rect | undefined;
  /** Target size when `region` was drawn. A mismatch means the target was resized and the
   * region now reads the wrong pixels — silently, so this is the only tell. */
  targetSize: { width: number; height: number } | undefined;
  /**
   * Selected capture target, as a descriptor that survives restarts — a bare id is a
   * window handle that dies with the window. Shared rather than page-local so a watcher
   * can keep running on the same target while you are on another page.
   */
  target: TargetDescriptor | undefined;
  /** Shows manual region tools and capture diagnostics. Auto-detect is the shipped path;
   * these exist for debugging and unusual setups. */
  devTools: boolean;
  /** Master volume for every sound the app makes, 0..1. */
  volume: number;
  alertTone: AlertTone;
  /** Root font-size multiplier; the window is resized to match. */
  uiScale: number;
}

export const DEFAULT_SETTINGS: CaptureSettings = {
  intervalMs: 500,
  region: undefined,
  targetSize: undefined,
  target: undefined,
  devTools: false,
  volume: 0.5,
  alertTone: "bell",
  uiScale: 1,
};

/** Bounds the UI enforces and the loader falls back on for out-of-range stored values. */
export const MIN_INTERVAL_MS = 50;
export const MAX_INTERVAL_MS = 5_000;

export function loadSettings(): CaptureSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CaptureSettings> & {
      targetId?: string;
      version?: number;
    };
    const currentVersion = (parsed.version ?? 1) >= SETTINGS_VERSION;
    return {
      intervalMs: clampInterval(parsed.intervalMs ?? DEFAULT_SETTINGS.intervalMs),
      region: currentVersion ? (parsed.region ?? undefined) : undefined,
      targetSize: currentVersion ? (parsed.targetSize ?? undefined) : undefined,
      // A stored autoStart from older versions is ignored: the persistent per-feature
      // switches replaced it.
      target: parsed.target ?? migrateLegacyTargetId(parsed.targetId),
      devTools: parsed.devTools ?? DEFAULT_SETTINGS.devTools,
      volume:
        typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
          ? Math.min(1, Math.max(0, parsed.volume))
          : DEFAULT_SETTINGS.volume,
      alertTone: (["bell", "chime", "horn"] as const).includes(parsed.alertTone as AlertTone)
        ? (parsed.alertTone as AlertTone)
        : DEFAULT_SETTINGS.alertTone,
      uiScale: (UI_SCALES as readonly number[]).includes(parsed.uiScale as number)
        ? (parsed.uiScale as number)
        : DEFAULT_SETTINGS.uiScale,
    };
  } catch {
    // Corrupt or unreadable storage should never stop the app from opening.
    return DEFAULT_SETTINGS;
  }
}

/**
 * Pre-descriptor versions stored a bare id. Carrying it costs nothing: the id still
 * resolves within the session it was written, the empty fields are barred from descriptor
 * matching, and the game-client heuristic covers the restart case.
 */
function migrateLegacyTargetId(targetId: string | undefined): TargetDescriptor | undefined {
  if (!targetId) return undefined;
  return {
    id: targetId,
    kind: targetId.startsWith("monitor:") ? "monitor" : "window",
    title: "",
    appName: "",
  };
}

export function saveSettings(settings: CaptureSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
}

export function clampInterval(ms: number) {
  if (!Number.isFinite(ms)) return DEFAULT_SETTINGS.intervalMs;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}
