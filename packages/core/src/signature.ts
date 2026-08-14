import { BYTES_PER_PIXEL, type Frame } from "./frame.js";

export const DEFAULT_SIGNATURE_SAMPLES = 4096;

/**
 * Cheap content fingerprint of a frame.
 *
 * Samples pixels on a fixed stride and folds them with FNV-1a, so it is O(samples)
 * rather than O(pixels) — cheap enough to run on every frame of a 4K grab. Two frames
 * with the same dimensions and the same sampled pixels produce the same value.
 *
 * This answers "did anything change?" without diffing megabytes: useful for skipping
 * redundant analysis, and for telling "capture stopped" apart from "the screen is
 * genuinely static", which look identical in a preview.
 *
 * Not a hash for security or exact equality — unsampled pixels are invisible to it.
 */
export function frameSignature(frame: Frame, samples = DEFAULT_SIGNATURE_SAMPLES): number {
  const pixels = frame.width * frame.height;

  // Fold dimensions in first, so a resize always changes the signature even if the
  // sampled colours happen to coincide.
  let hash = 0x81_1c_9d_c5;
  hash = mix(hash, frame.width);
  hash = mix(hash, frame.height);
  if (pixels === 0) return hash >>> 0;

  const stride = samples > 0 ? Math.max(1, Math.floor(pixels / samples)) : 1;
  const { data } = frame;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * BYTES_PER_PIXEL;
    hash = mix(hash, data[offset] ?? 0);
    hash = mix(hash, data[offset + 1] ?? 0);
    hash = mix(hash, data[offset + 2] ?? 0);
  }

  return hash >>> 0;
}

/** FNV-1a step. `Math.imul` keeps the multiply in 32 bits. */
function mix(hash: number, byte: number) {
  return Math.imul(hash ^ (byte & 0xff), 0x01_00_01_93);
}

/** Signature as a short hex string, for logs and diagnostics. */
export function formatSignature(signature: number) {
  return signature.toString(16).padStart(8, "0");
}
