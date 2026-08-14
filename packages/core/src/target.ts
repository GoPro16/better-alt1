import type { Rect } from "./geometry.js";

export type CaptureTargetKind = "monitor" | "window";

/**
 * Something we can grab pixels from. Mirrors the `CaptureTarget` struct in
 * `apps/desktop/src-tauri/src/capture.rs` — the serde field names are the contract.
 */
export interface CaptureTarget {
  /** Stable within a session only — window ids are per-instance handles that die with the
   * window. Persist a `TargetDescriptor` and resolve it with `resolveTarget` instead. */
  id: string;
  kind: CaptureTargetKind;
  /** Monitor name, or window title. */
  title: string;
  /** Owning process name for windows; empty for monitors. */
  appName: string;
  /** Position and size in virtual-desktop coordinates. */
  bounds: Rect;
  /** Monitors only: OS scale factor, e.g. 1.5 on a 150% display. */
  scaleFactor: number;
  isPrimary: boolean;
  /** Windows only. A minimised window generally cannot be captured. */
  isMinimized: boolean;
}

/**
 * Heuristic match for the RuneScape client among enumerated windows.
 *
 * `/runescape/i` already covers "RuneScape", "Old School RuneScape" and the
 * "RuneScape Client" process name; the anchored patterns exist for clients whose name
 * would otherwise be too generic to match loosely.
 */
const CLIENT_PATTERNS = [/runescape/i, /jagex/i, /^runelite$/i, /^rs2client$/i];

export function looksLikeGameClient(target: CaptureTarget) {
  if (target.kind !== "window") return false;
  // Match each field on its own. Concatenating title and appName would defeat every
  // anchored pattern above, since the combined string never starts and ends with one.
  return [target.title, target.appName].some((field) => {
    const value = field.trim();
    return value.length > 0 && CLIENT_PATTERNS.some((pattern) => pattern.test(value));
  });
}

/** Game-client windows first, then remaining windows, then monitors. */
export function rankTargets(targets: readonly CaptureTarget[]): CaptureTarget[] {
  const score = (t: CaptureTarget) => {
    if (looksLikeGameClient(t)) return 0;
    if (t.kind === "window") return 1;
    return 2;
  };
  return targets.toSorted((a, b) => score(a) - score(b) || a.title.localeCompare(b.title));
}

/**
 * The identity of a target that survives restarts. A bare `id` does not — on Windows it is
 * the HWND, minted fresh every time the client launches — so this is what gets persisted,
 * and `resolveTarget` turns it back into a live target against a fresh enumeration.
 */
export interface TargetDescriptor {
  id: string;
  kind: CaptureTargetKind;
  title: string;
  appName: string;
}

export function describeTarget(target: CaptureTarget): TargetDescriptor {
  return { id: target.id, kind: target.kind, title: target.title, appName: target.appName };
}

/** How a descriptor was matched — the fast path, a restarted window, or pure detection. */
export type ResolutionVia = "id" | "descriptor" | "heuristic";

export interface Resolution {
  target: CaptureTarget;
  via: ResolutionVia;
}

/**
 * Find the descriptor's target in a fresh enumeration, degrading gracefully: exact id
 * (same session) → same window by title or app name (client restarted) → any game-looking
 * client (nothing usable persisted). Returns `undefined` rather than guessing at an
 * arbitrary window — a wrong auto-pick is worse than none.
 */
export function resolveTarget(
  descriptor: TargetDescriptor | undefined,
  targets: readonly CaptureTarget[],
): Resolution | undefined {
  if (descriptor) {
    const byId = targets.find((t) => t.id === descriptor.id);
    if (byId) return { target: byId, via: "id" };

    const candidates = targets.filter(
      (t) => t.kind === descriptor.kind && matchesDescriptor(descriptor, t),
    );
    const best = pickBest(candidates, descriptor);
    if (best) return { target: best, via: "descriptor" };
  }

  const clients = rankTargets(targets).filter(looksLikeGameClient);
  const client = clients.find((t) => !t.isMinimized) ?? clients[0];
  return client ? { target: client, via: "heuristic" } : undefined;
}

/** Empty descriptor fields never match — a legacy id-only descriptor must not descriptor-
 * match arbitrary windows. */
function matchesDescriptor(descriptor: TargetDescriptor, target: CaptureTarget) {
  return (
    (descriptor.appName.length > 0 && target.appName === descriptor.appName) ||
    (descriptor.title.length > 0 && target.title === descriptor.title)
  );
}

/**
 * Among several matches (multi-boxed clients share an app name), an exact title wins,
 * then a window that is actually on screen; `rankTargets` keeps the rest deterministic.
 */
function pickBest(candidates: readonly CaptureTarget[], descriptor: TargetDescriptor) {
  if (candidates.length <= 1) return candidates[0];
  const score = (t: CaptureTarget) =>
    (descriptor.title.length > 0 && t.title === descriptor.title ? 0 : 2) +
    (t.isMinimized ? 1 : 0);
  return rankTargets(candidates).toSorted((a, b) => score(a) - score(b))[0];
}
