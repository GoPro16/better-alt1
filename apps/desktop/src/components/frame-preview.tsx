import type { Rect } from "@better-alt1/core";
import { useEffect, useRef, useState } from "react";
import { drawBitmap, hex, pixelFromCanvas } from "@/lib/canvas";
import { cn } from "@/lib/utils";

/** Drags smaller than this are treated as a click, not a selection. */
const MIN_DRAG_PX = 6;

interface Probe {
  x: number;
  y: number;
  color: string;
}

/** A drag in progress, in canvas display pixels. */
interface Drag {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

interface FramePreviewProps {
  bitmap: ImageBitmap | undefined;
  /**
   * The rect of the capture target the bitmap represents, in target-local coordinates.
   * Needed to map a selection back when the preview is a crop, a downscale, or both.
   */
  sourceRect?: Rect;
  /** Called with a target-local rect when the user drags out a selection. */
  onSelectRegion?: (region: Rect) => void;
  /** An existing region to show on the preview, in target-local coordinates. */
  highlight?: Rect;
  className?: string;
}

export function FramePreview({
  bitmap,
  sourceRect,
  onSelectRegion,
  highlight,
  className,
}: FramePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingProbe = useRef<number>(0);
  const [probe, setProbe] = useState<Probe>();
  const [drag, setDrag] = useState<Drag>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && bitmap) drawBitmap(canvas, bitmap);
  }, [bitmap]);

  useEffect(() => () => cancelAnimationFrame(pendingProbe.current), []);

  const canSelect = onSelectRegion !== undefined && sourceRect !== undefined;

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canSelect || event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ fromX: x, fromY: y, toX: x, toY: y });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;

    if (drag) {
      setDrag({ ...drag, toX: x, toY: y });
      return;
    }

    // Pointer events fire faster than the screen refreshes; without coalescing this is
    // hundreds of React state updates a second, competing with the capture loop.
    if (!bitmap) return;
    cancelAnimationFrame(pendingProbe.current);
    pendingProbe.current = requestAnimationFrame(() => {
      const px = Math.floor((x / box.width) * bitmap.width);
      const py = Math.floor((y / box.height) * bitmap.height);
      const pixel = pixelFromCanvas(canvas, px, py);
      setProbe(pixel ? { x: px, y: py, color: hex(pixel.r, pixel.g, pixel.b) } : undefined);
    });
  };

  const onPointerUp = () => {
    if (!drag) return;
    const width = Math.abs(drag.toX - drag.fromX);
    const height = Math.abs(drag.toY - drag.fromY);
    setDrag(undefined);

    const canvas = canvasRef.current;
    if (!canvas || !sourceRect || width < MIN_DRAG_PX || height < MIN_DRAG_PX) return;

    const box = canvas.getBoundingClientRect();
    const scaleX = sourceRect.width / box.width;
    const scaleY = sourceRect.height / box.height;
    const left = Math.min(drag.fromX, drag.toX);
    const top = Math.min(drag.fromY, drag.toY);

    onSelectRegion?.({
      x: Math.round(sourceRect.x + left * scaleX),
      y: Math.round(sourceRect.y + top * scaleY),
      width: Math.max(1, Math.round(width * scaleX)),
      height: Math.max(1, Math.round(height * scaleY)),
    });
  };

  const box = drag
    ? {
        left: Math.min(drag.fromX, drag.toX),
        top: Math.min(drag.fromY, drag.toY),
        width: Math.abs(drag.toX - drag.fromX),
        height: Math.abs(drag.toY - drag.fromY),
      }
    : undefined;

  // Percentages of the canvas, so the overlay needs no knowledge of the rendered size.
  const highlightBox =
    highlight && sourceRect
      ? {
          left: `${((highlight.x - sourceRect.x) / sourceRect.width) * 100}%`,
          top: `${((highlight.y - sourceRect.y) / sourceRect.height) * 100}%`,
          width: `${(highlight.width / sourceRect.width) * 100}%`,
          height: `${(highlight.height / sourceRect.height) * 100}%`,
        }
      : undefined;

  return (
    <div
      className={cn(
        "relative grid min-h-56 place-items-center overflow-hidden rounded-md border bg-muted/30 p-2",
        className,
      )}
    >
      {bitmap ? (
        // Wraps the canvas tightly so the selection overlay shares its coordinate space.
        <div className="relative leading-none">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              cancelAnimationFrame(pendingProbe.current);
              setProbe(undefined);
            }}
            // Nearest-neighbour keeps pixel inspection honest when downscaled.
            className="max-h-[60vh] max-w-full cursor-crosshair [image-rendering:pixelated]"
          />
          {box && (
            <div
              className="pointer-events-none absolute border-2 border-primary bg-primary/20"
              style={box}
            />
          )}
          {/* Dashed to read as "current", against the solid in-progress drag box. */}
          {highlightBox && !drag && (
            <div
              className="pointer-events-none absolute border-2 border-dashed border-primary/70"
              style={highlightBox}
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No frame captured yet.</p>
      )}

      {bitmap && canSelect && !drag && (
        <p className="absolute left-3 top-3 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur">
          drag to set capture region
        </p>
      )}

      {probe && (
        <div className="absolute bottom-3 right-3 flex items-center gap-2 rounded-md border bg-background/90 px-2 py-1 font-mono text-xs tabular-nums shadow-sm backdrop-blur">
          <span>
            {probe.x}, {probe.y}
          </span>
          <span className="size-3 rounded-sm border" style={{ background: probe.color }} />
          <span>{probe.color}</span>
        </div>
      )}
    </div>
  );
}
