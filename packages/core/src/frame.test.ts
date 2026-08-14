import { describe, expect, it } from "vitest";
import {
  BYTES_PER_PIXEL,
  FRAME_HEADER_BYTES,
  FrameDecodeError,
  createFrame,
  cropFrame,
  decodeFrame,
  frameBounds,
  getPixel,
  getRgb,
  offsetOf,
} from "./frame.js";
import { rect } from "./geometry.js";

/**
 * Mirror of the Rust writer in `src-tauri/src/capture.rs`. Reimplemented rather than
 * imported so a drift in the real encoder shows up as a failure instead of being
 * cancelled out by a shared helper.
 */
function encode(width: number, height: number, pixels: number[], capturedAt = 0) {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + pixels.length);
  const view = new DataView(buffer);
  view.setUint8(0, 0x42); // B
  view.setUint8(1, 0x41); // A
  view.setUint8(2, 0x31); // 1
  view.setUint8(3, 0x46); // F
  view.setUint8(4, 1); // version
  view.setUint8(5, 0); // RGBA8
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setBigUint64(16, BigInt(capturedAt), true);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(pixels);
  return buffer;
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

describe("decodeFrame", () => {
  it("reads dimensions, timestamp and pixels", () => {
    const frame = decodeFrame(encode(2, 1, [...RED, ...GREEN], 1_700_000_000_123));

    expect(frame.width).toBe(2);
    expect(frame.height).toBe(1);
    expect(frame.capturedAt).toBe(1_700_000_000_123);
    expect(getPixel(frame, 0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(getPixel(frame, 1, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("survives a timestamp beyond 2^32 milliseconds", () => {
    // A u32 truncation bug would silently wreck every capture time.
    const frame = decodeFrame(encode(1, 1, RED, 1_800_000_000_000));
    expect(frame.capturedAt).toBe(1_800_000_000_000);
  });

  it("rejects a buffer shorter than the header", () => {
    expect(() => decodeFrame(new ArrayBuffer(8))).toThrow(FrameDecodeError);
  });

  it("rejects bad magic", () => {
    const buffer = encode(1, 1, RED);
    new DataView(buffer).setUint8(0, 0x58);
    expect(() => decodeFrame(buffer)).toThrow(/magic/);
  });

  it("rejects an unknown version", () => {
    const buffer = encode(1, 1, RED);
    new DataView(buffer).setUint8(4, 99);
    expect(() => decodeFrame(buffer)).toThrow(/version 99/);
  });

  it("rejects an unknown pixel format", () => {
    const buffer = encode(1, 1, RED);
    new DataView(buffer).setUint8(5, 7);
    expect(() => decodeFrame(buffer)).toThrow(/pixel format 7/);
  });

  it("rejects a payload that does not match the declared dimensions", () => {
    const buffer = encode(4, 4, RED); // claims 4x4, carries one pixel
    expect(() => decodeFrame(buffer)).toThrow(/needs 64 pixel bytes, got 4/);
  });

  it("exposes pixels as a plain-ArrayBuffer view, as ImageData requires", () => {
    const frame = decodeFrame(encode(1, 1, RED));
    expect(frame.data.buffer).toBeInstanceOf(ArrayBuffer);
    expect(frame.data.byteLength).toBe(BYTES_PER_PIXEL);
  });
});

describe("pixel access", () => {
  const frame = decodeFrame(encode(2, 2, [...RED, ...GREEN, ...BLUE, ...WHITE]));

  it("indexes row-major, top-down", () => {
    expect(getRgb(frame, 0, 0)).toBe(0xff0000);
    expect(getRgb(frame, 1, 0)).toBe(0x00ff00);
    expect(getRgb(frame, 0, 1)).toBe(0x0000ff);
    expect(getRgb(frame, 1, 1)).toBe(0xffffff);
  });

  it("reports out-of-bounds rather than wrapping to the next row", () => {
    expect(offsetOf(frame, 2, 0)).toBe(-1);
    expect(getPixel(frame, 2, 0)).toBeUndefined();
    expect(getPixel(frame, 0, -1)).toBeUndefined();
    expect(getRgb(frame, 99, 99)).toBe(-1);
  });

  it("frameBounds describes the whole image", () => {
    expect(frameBounds(frame)).toEqual(rect(0, 0, 2, 2));
  });
});

describe("cropFrame", () => {
  const frame = decodeFrame(encode(2, 2, [...RED, ...GREEN, ...BLUE, ...WHITE]));

  it("extracts a single pixel", () => {
    const cropped = cropFrame(frame, rect(1, 1, 1, 1));
    expect([cropped.width, cropped.height]).toEqual([1, 1]);
    expect(getRgb(cropped, 0, 0)).toBe(0xffffff);
  });

  it("extracts a column across rows", () => {
    const cropped = cropFrame(frame, rect(1, 0, 1, 2));
    expect([cropped.width, cropped.height]).toEqual([1, 2]);
    expect(getRgb(cropped, 0, 0)).toBe(0x00ff00);
    expect(getRgb(cropped, 0, 1)).toBe(0xffffff);
  });

  it("clips an oversized region instead of reading past the buffer", () => {
    const cropped = cropFrame(frame, rect(1, 1, 100, 100));
    expect([cropped.width, cropped.height]).toEqual([1, 1]);
  });

  it("returns an empty frame when the region misses entirely", () => {
    const cropped = cropFrame(frame, rect(50, 50, 10, 10));
    expect([cropped.width, cropped.height]).toEqual([0, 0]);
    expect(cropped.data.byteLength).toBe(0);
  });

  it("preserves the capture timestamp", () => {
    const stamped = decodeFrame(encode(2, 2, [...RED, ...GREEN, ...BLUE, ...WHITE], 42));
    expect(cropFrame(stamped, rect(0, 0, 1, 1)).capturedAt).toBe(42);
  });
});

describe("createFrame", () => {
  it("allocates exactly width * height * 4 zeroed bytes", () => {
    const frame = createFrame(3, 5);
    expect(frame.data.byteLength).toBe(3 * 5 * BYTES_PER_PIXEL);
    expect(frame.data.every((byte) => byte === 0)).toBe(true);
  });
});
