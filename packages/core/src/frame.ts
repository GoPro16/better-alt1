import { type Rect, intersect, isEmpty, rect } from "./geometry.js";

/**
 * Wire format for a captured frame crossing the Tauri IPC boundary.
 *
 * Little-endian throughout. Must stay byte-identical to the writer in
 * `apps/desktop/src-tauri/src/capture.rs`.
 *
 *   offset  size  field
 *   0       4     magic, ASCII "BA1F"
 *   4       1     version, currently 1
 *   5       1     pixel format, 0 = RGBA8
 *   6       2     reserved, zero
 *   8       4     width in pixels, u32
 *   12      4     height in pixels, u32
 *   16      8     capture time, u64 milliseconds since the Unix epoch
 *   24      ..    pixel rows, top-down, stride = width * 4, no row padding
 */
export const FRAME_HEADER_BYTES = 24;
export const FRAME_MAGIC = 0x42413146; // "BA1F"
export const FRAME_VERSION = 1;
export const PIXEL_FORMAT_RGBA8 = 0;
export const BYTES_PER_PIXEL = 4;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A decoded RGBA8 image. `data` is exactly `width * height * 4` bytes. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  /** Milliseconds since the Unix epoch, stamped when the pixels were grabbed. */
  readonly capturedAt: number;
  /**
   * Backed by a plain `ArrayBuffer`, not `ArrayBufferLike` — `ImageData` rejects
   * `SharedArrayBuffer`-backed views, and every frame ends up on a canvas.
   */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

export function createFrame(width: number, height: number, capturedAt = 0): Frame {
  return {
    width,
    height,
    capturedAt,
    data: new Uint8ClampedArray(width * height * BYTES_PER_PIXEL),
  };
}

/** Parse the buffer returned by the `capture_frame` Tauri command. */
export function decodeFrame(buffer: ArrayBuffer): Frame {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new FrameDecodeError(
      `buffer of ${buffer.byteLength} bytes is shorter than the ${FRAME_HEADER_BYTES}-byte header`,
    );
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, false);
  if (magic !== FRAME_MAGIC) {
    throw new FrameDecodeError(`bad magic 0x${magic.toString(16)}, expected "BA1F"`);
  }

  const version = view.getUint8(4);
  if (version !== FRAME_VERSION) {
    throw new FrameDecodeError(`unsupported frame version ${version}`);
  }

  const format = view.getUint8(5);
  if (format !== PIXEL_FORMAT_RGBA8) {
    throw new FrameDecodeError(`unsupported pixel format ${format}`);
  }

  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const capturedAt = Number(view.getBigUint64(16, true));

  const expected = width * height * BYTES_PER_PIXEL;
  const actual = buffer.byteLength - FRAME_HEADER_BYTES;
  if (actual !== expected) {
    throw new FrameDecodeError(
      `${width}x${height} needs ${expected} pixel bytes, got ${actual}`,
    );
  }

  return {
    width,
    height,
    capturedAt,
    data: new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES, expected),
  };
}

export function frameBounds(frame: Frame): Rect {
  return rect(0, 0, frame.width, frame.height);
}

/** Byte offset of a pixel, or -1 when out of bounds. */
export function offsetOf(frame: Frame, x: number, y: number) {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return -1;
  return (y * frame.width + x) * BYTES_PER_PIXEL;
}

export function getPixel(frame: Frame, x: number, y: number): Rgba | undefined {
  const offset = offsetOf(frame, x, y);
  if (offset < 0) return undefined;
  const { data } = frame;
  return {
    r: data[offset] ?? 0,
    g: data[offset + 1] ?? 0,
    b: data[offset + 2] ?? 0,
    a: data[offset + 3] ?? 0,
  };
}

/** Pixel packed as 0xRRGGBB, alpha discarded. Handy for exact colour matching. */
export function getRgb(frame: Frame, x: number, y: number) {
  const offset = offsetOf(frame, x, y);
  if (offset < 0) return -1;
  const { data } = frame;
  return ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
}

/**
 * Copy a sub-rectangle into a new frame. The region is clipped to the source, so the
 * result may be smaller than requested — check the returned dimensions.
 */
export function cropFrame(frame: Frame, region: Rect): Frame {
  const clipped = intersect(region, frameBounds(frame));
  if (isEmpty(clipped)) return createFrame(0, 0, frame.capturedAt);

  const out = createFrame(clipped.width, clipped.height, frame.capturedAt);
  const rowBytes = clipped.width * BYTES_PER_PIXEL;
  for (let row = 0; row < clipped.height; row += 1) {
    const from = ((clipped.y + row) * frame.width + clipped.x) * BYTES_PER_PIXEL;
    out.data.set(frame.data.subarray(from, from + rowBytes), row * rowBytes);
  }
  return out;
}
