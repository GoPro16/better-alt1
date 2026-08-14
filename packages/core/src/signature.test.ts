import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { type Frame, createFrame } from "./frame.js";
import { formatSignature, frameSignature } from "./signature.js";

function filled(width: number, height: number, fill: (index: number) => number): Frame {
  const frame = createFrame(width, height);
  for (let index = 0; index < frame.data.length; index += 1) {
    frame.data[index] = fill(index);
  }
  return frame;
}

describe("frameSignature", () => {
  it("is stable for identical content", () => {
    const a = filled(32, 32, (i) => i % 251);
    const b = filled(32, 32, (i) => i % 251);
    expect(frameSignature(a)).toBe(frameSignature(b));
  });

  it("changes when a sampled pixel changes", () => {
    const frame = filled(32, 32, (i) => i % 251);
    const before = frameSignature(frame);
    // Pixel 0 is always sampled, whatever the stride.
    frame.data[0] = (frame.data[0] ?? 0) ^ 0xff;
    expect(frameSignature(frame)).not.toBe(before);
  });

  it("changes when dimensions change even if colours match", () => {
    const wide = filled(64, 16, () => 7);
    const tall = filled(16, 64, () => 7);
    expect(frameSignature(wide)).not.toBe(frameSignature(tall));
  });

  it("ignores alpha, which capture forces to opaque anyway", () => {
    const frame = filled(8, 8, () => 10);
    const before = frameSignature(frame);
    for (let offset = 3; offset < frame.data.length; offset += 4) frame.data[offset] = 128;
    expect(frameSignature(frame)).toBe(before);
  });

  it("handles an empty frame without throwing", () => {
    expect(() => frameSignature(createFrame(0, 0))).not.toThrow();
  });

  it("distinguishes a black frame from a white one", () => {
    expect(frameSignature(filled(16, 16, () => 0))).not.toBe(
      frameSignature(filled(16, 16, () => 255)),
    );
  });

  it("returns an unsigned 32-bit value", () => {
    const signature = frameSignature(filled(40, 40, (i) => (i * 31) % 256));
    expect(Number.isInteger(signature)).toBe(true);
    expect(signature).toBeGreaterThanOrEqual(0);
    expect(signature).toBeLessThanOrEqual(0xff_ff_ff_ff);
  });

  it("stays cheap on a large frame by sampling rather than reading everything", () => {
    // 4K-sized frame; a full read would be 33 MB of work per call.
    const frame = createFrame(3840, 2160);
    const started = performance.now();
    frameSignature(frame);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("formatSignature", () => {
  it("pads to eight hex digits", () => {
    expect(formatSignature(0)).toBe("00000000");
    expect(formatSignature(0xdeadbeef)).toBe("deadbeef");
  });
});
