import type { Rect } from "@better-alt1/core";

const STORAGE_KEY = "better-alt1.afk-warden";

export const MIN_IDLE_SECONDS = 5;
export const MAX_IDLE_SECONDS = 300;

/**
 * The Alt1 AfkWarden model, smallest useful piece: watch a region, alarm when it stops
 * changing for N seconds. The XP counter is the ideal region — it changes exactly when
 * you gain xp, so it freezing means you stopped skilling.
 */
export interface AfkConfig {
  enabled: boolean;
  /** Seconds of an unchanged region before the alarm. */
  idleAfterSeconds: number;
  /** Watched region, target-local; owned by this feature. */
  region: Rect | undefined;
  /** Target size when `region` was drawn; a mismatch means the region is stale. */
  targetSize: { width: number; height: number } | undefined;
  sound: boolean;
  flash: boolean;
}

export const DEFAULT_AFK_CONFIG: AfkConfig = {
  enabled: false,
  idleAfterSeconds: 30,
  region: undefined,
  targetSize: undefined,
  sound: true,
  flash: true,
};

export function clampIdleSeconds(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_AFK_CONFIG.idleAfterSeconds;
  return Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(value)));
}

export function loadAfkConfig(): AfkConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AFK_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AfkConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_AFK_CONFIG.enabled,
      idleAfterSeconds: clampIdleSeconds(parsed.idleAfterSeconds ?? DEFAULT_AFK_CONFIG.idleAfterSeconds),
      region: parsed.region ?? undefined,
      targetSize: parsed.targetSize ?? undefined,
      sound: parsed.sound ?? DEFAULT_AFK_CONFIG.sound,
      flash: parsed.flash ?? DEFAULT_AFK_CONFIG.flash,
    };
  } catch {
    // Corrupt storage must never stop the app from opening.
    return DEFAULT_AFK_CONFIG;
  }
}

export function saveAfkConfig(config: AfkConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
