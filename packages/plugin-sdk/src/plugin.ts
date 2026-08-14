import type { CaptureTarget, Rect } from "@better-alt1/core";
import type { FrameHandle, FrameReader } from "./frame.js";
import type { Overlay } from "./overlay.js";

/**
 * Capabilities a plugin may request. Deliberately observation-only: there is no
 * permission that grants input synthesis, process access, or network interception,
 * because the host cannot do those things at all. See CLAUDE.md.
 */
export type PluginPermission =
  /**
   * Read anywhere in the capture target rather than only inside the declared region of
   * interest. Expensive: whole-target grabs cost ~350ms against ~25ms for a region.
   */
  | "frames:full"
  /** Draw into the shared overlay window. */
  | "overlay"
  /** Persist configuration under the plugin's own namespace. */
  | "storage"
  /** Reach the network. Hosts may prompt and may restrict to `allowedHosts`. */
  | "network";

export interface PluginManifest {
  /** Reverse-DNS-ish and stable forever; it namespaces the plugin's stored config. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions?: readonly PluginPermission[];
  /** Required when `permissions` includes `network`. */
  allowedHosts?: readonly string[];
}

export interface PluginLogger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Everything the host hands a plugin. Nothing here can act on the game, and nothing here
 * hands over bulk pixels — see `FrameReader`.
 */
export interface PluginContext extends FrameReader {
  readonly manifest: PluginManifest;
  readonly log: PluginLogger;
  readonly storage: PluginStorage;
  readonly overlay: Overlay;
  /** The target frames are currently coming from, or `undefined` when none is selected. */
  readonly target: CaptureTarget | undefined;
  /**
   * Ask for a fresh grab now, optionally of a sub-region, instead of waiting for the next
   * scheduled frame. Returns a handle; rejects if capture fails, which is routine.
   */
  requestFrame(region?: Rect): Promise<FrameHandle>;
  /**
   * Limit capture to this region of the target. This is the single biggest lever a plugin
   * has over its own cost: a region grab is roughly fourteen times cheaper than a
   * whole-target grab, because cost scales with captured area.
   */
  setRegionOfInterest(region: Rect | undefined): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /** Called once when the plugin is enabled. Throwing here disables it. */
  activate?(ctx: PluginContext): void | Promise<void>;
  /**
   * Called per captured frame, with a handle rather than pixels. Keep it fast — the host
   * drops frames rather than queueing them, so a slow plugin lowers its own effective
   * frame rate, not the app's.
   */
  onFrame?(frame: FrameHandle, ctx: PluginContext): void | Promise<void>;
  /** Called when disabled or on app shutdown. Release timers and listeners here. */
  deactivate?(ctx: PluginContext): void | Promise<void>;
}

/** Identity helper that pins the type so editors autocomplete the hooks. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
