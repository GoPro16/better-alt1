import type { Point, Rect } from "@better-alt1/core";

/** CSS colour string, e.g. `#ff0`, `rgb(255 0 0 / 50%)`. */
export type Color = string;

interface BaseOp {
  /**
   * Auto-remove after this many milliseconds. Omit for "until the next frame from this
   * plugin", which is what most overlays want — a stale overlay is worse than none.
   */
  ttlMs?: number;
}

export interface RectOp extends BaseOp {
  kind: "rect";
  rect: Rect;
  color: Color;
  /** Outline width in pixels. `0` fills the rect instead. */
  lineWidth?: number;
}

export interface LineOp extends BaseOp {
  kind: "line";
  from: Point;
  to: Point;
  color: Color;
  lineWidth?: number;
}

export interface TextOp extends BaseOp {
  kind: "text";
  at: Point;
  text: string;
  color: Color;
  /** Pixel size; the host picks the family so overlays stay legible and consistent. */
  size?: number;
  /** Draw a contrasting outline so text stays readable over any background. */
  halo?: boolean;
  align?: "left" | "center" | "right";
}

export type OverlayOp = RectOp | LineOp | TextOp;

/**
 * Draws into the host's transparent always-on-top overlay window. Coordinates are in
 * virtual-desktop pixels — the same space as `CaptureTarget.bounds` — so a plugin that
 * found something at frame coordinates must offset by the target's origin first.
 */
export interface Overlay {
  draw(op: OverlayOp): void;
  /** Convenience wrappers over `draw`. */
  rect(r: Rect, color: Color, lineWidth?: number): void;
  line(from: Point, to: Point, color: Color, lineWidth?: number): void;
  text(at: Point, text: string, color: Color, size?: number): void;
  /** Remove everything this plugin has drawn. */
  clear(): void;
}
