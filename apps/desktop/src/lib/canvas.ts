/**
 * Decode PNG bytes into a GPU-ready bitmap.
 *
 * `createImageBitmap` does the decode off the main thread, which is the point: the
 * alternative — raw RGBA plus `putImageData` — does the work on the thread that also has
 * to keep the UI responsive.
 */
export async function decodePng(bytes: Uint8Array): Promise<ImageBitmap> {
  // Copy into a fresh buffer: Blob wants an ArrayBuffer, and the view may be offset.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" });
  return createImageBitmap(blob);
}

/** Paint a bitmap at 1:1, resizing the canvas only when the dimensions change. */
export function drawBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap) {
  // Assigning width/height reallocates and clears the backing store even when the value
  // is unchanged, so only resize on a real change.
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  ctx.drawImage(bitmap, 0, 0);
}

/**
 * Read one pixel back from the canvas.
 *
 * Cheaper than keeping a full RGBA copy in JS purely to answer hover queries, and honest
 * because the preview is losslessly encoded.
 */
export function pixelFromCanvas(canvas: HTMLCanvasElement, x: number, y: number) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return { r, g, b };
}

export function hex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
