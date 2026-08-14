import type { Point, Rect } from "@better-alt1/core";

/**
 * A frame held in native memory. Plugins never receive its pixels.
 *
 * This mirrors Alt1's `bindRegion`, documented as binding a region "in memory to apply
 * functions to it without having to transfer it to the browser". The reason is measured,
 * not stylistic: moving a frame across the webview boundary costs seconds past ~2 MiB,
 * while asking a question about it costs tens of bytes. A plugin that wants to know
 * whether an icon is lit should get back a coordinate, not a bitmap.
 */
export interface FrameHandle {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** Milliseconds since the Unix epoch, stamped when the pixels were grabbed. */
  readonly capturedAt: number;
  /** Which part of the capture target this frame covers, in target-local coordinates. */
  readonly source: Rect;
  /** Native size in bytes — what you are *not* paying to transfer. */
  readonly byteLen: number;
}

/** Packed 0xAARRGGBB, as returned by single-pixel reads. */
export type PackedColor = number;

export interface Template {
  width: number;
  height: number;
  /** Tightly packed RGBA8, exactly `width * height * 4` bytes. */
  pixels: Uint8Array;
  /**
   * Template pixels with alpha below this are wildcards, so a template can describe an
   * irregular shape without also matching its background.
   */
  alphaThreshold?: number;
}

export interface FindOptions {
  /** Restrict the search to this part of the frame. */
  region?: Rect;
  /**
   * Maximum per-channel difference still counted as a match. Screen capture is not
   * bit-exact — compositing, scaling and colour management perturb pixels by a step or
   * two — so an exact-match search on real captures often finds nothing. Start around 2.
   */
  tolerance?: number;
  maxMatches?: number;
}

/**
 * Questions a plugin can ask about a frame. Every one of these runs natively and returns
 * a small result.
 */
export interface FrameReader {
  getPixel(frame: FrameHandle, x: number, y: number): Promise<PackedColor | undefined>;

  /**
   * Content fingerprint, for skipping work when nothing changed. Cheap: it samples on a
   * stride rather than reading every pixel.
   */
  signature(frame: FrameHandle, region?: Rect, samples?: number): Promise<number>;

  findSubimage(
    frame: FrameHandle,
    template: Template,
    options?: FindOptions,
  ): Promise<Point[]>;

  /**
   * Raw RGBA for a **small** region, when a plugin genuinely needs to do its own pixel
   * work. Rejects above a size limit rather than stalling the app — if you are hitting
   * that limit, the operation belongs in a native command instead.
   */
  getRegion(frame: FrameHandle, region: Rect): Promise<Uint8Array>;

  /**
   * Drop a frame early. Frames expire on their own, so this is an optimisation rather
   * than a requirement, and forgetting it cannot leak.
   */
  release(frame: FrameHandle): Promise<void>;
}
