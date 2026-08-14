/**
 * Decodes bytes captured from a real, running RuneScape client — the exact payload
 * `capture_frame` puts on the IPC wire. This is the only test that proves the Rust
 * encoder and the TypeScript decoder agree; the unit tests each use their own encoder
 * and would both stay green if the two drifted apart.
 *
 * Regenerate with:
 *   pnpm fixture rs-client --target runescape --region 2900,1500,320,180
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BYTES_PER_PIXEL, FRAME_HEADER_BYTES, cropFrame, decodeFrame, getPixel } from "../src/frame.js";
import { rect } from "../src/geometry.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/rs-client.ba1f", import.meta.url));

async function loadFixture() {
  const file = await readFile(FIXTURE);
  // Node may hand back a Buffer sharing a larger pool; hand the decoder just our bytes.
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

describe("golden frame from a live client", () => {
  it("decodes to the region that was requested", async () => {
    const frame = decodeFrame(await loadFixture());

    expect(frame.width).toBe(320);
    expect(frame.height).toBe(180);
    expect(frame.data.byteLength).toBe(320 * 180 * BYTES_PER_PIXEL);
  });

  it("carries a plausible capture timestamp", async () => {
    const frame = decodeFrame(await loadFixture());

    // Sanity, not precision: catches a zeroed, truncated, or seconds-vs-millis stamp.
    expect(frame.capturedAt).toBeGreaterThan(Date.parse("2020-01-01"));
    expect(frame.capturedAt).toBeLessThan(Date.parse("2100-01-01"));
  });

  it("is fully opaque, so alpha is not mistaken for transparency downstream", async () => {
    const frame = decodeFrame(await loadFixture());

    let transparent = 0;
    for (let offset = 3; offset < frame.data.length; offset += BYTES_PER_PIXEL) {
      if (frame.data[offset] !== 255) transparent += 1;
    }

    expect(transparent).toBe(0);
  });

  it("contains real image content rather than a black or uniform buffer", async () => {
    const frame = decodeFrame(await loadFixture());

    const seen = new Set<number>();
    let nonBlack = 0;
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const pixel = getPixel(frame, x, y);
        if (!pixel) continue;
        if (pixel.r > 0 || pixel.g > 0 || pixel.b > 0) nonBlack += 1;
        seen.add((pixel.r << 16) | (pixel.g << 8) | pixel.b);
      }
    }

    const total = frame.width * frame.height;
    expect(nonBlack / total).toBeGreaterThan(0.5);
    // A stuck or placeholder buffer would have a handful of distinct colours at most.
    expect(seen.size).toBeGreaterThan(500);
  });

  it("has no row-stride padding, so crops line up with the source", async () => {
    const frame = decodeFrame(await loadFixture());
    expect(frame.data.byteLength).toBe(frame.width * frame.height * BYTES_PER_PIXEL);

    // A stride bug shows up as a crop that does not match direct pixel indexing.
    const cropped = cropFrame(frame, rect(100, 50, 8, 8));
    expect([cropped.width, cropped.height]).toEqual([8, 8]);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        expect(getPixel(cropped, x, y)).toEqual(getPixel(frame, 100 + x, 50 + y));
      }
    }
  });

  it("is exactly header + pixels, with nothing appended", async () => {
    const buffer = await loadFixture();
    expect(buffer.byteLength).toBe(FRAME_HEADER_BYTES + 320 * 180 * BYTES_PER_PIXEL);
  });
});
