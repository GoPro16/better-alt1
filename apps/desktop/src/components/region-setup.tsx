import type { CaptureTarget, Rect } from "@better-alt1/core";
import { FramePreview } from "@/components/frame-preview";
import { Reveal } from "@/components/reveal";
import { useFrameStream } from "@/hooks/use-capture";

interface RegionSetupProps {
  target: CaptureTarget | undefined;
  /** Current region, target-local; shown dashed on the preview. */
  region: Rect | undefined;
  /** The parent owns the trigger and pauses its own capture loop while this is open —
   * two loops with a whole-target grab in one of them starve each other. */
  open: boolean;
  /** What to tell the user to drag around — feature-specific. */
  hint: string;
  onSelectRegion: (region: Rect) => void;
}

/**
 * Inline region picker: a live whole-target preview to drag a region on, without leaving
 * the page. The stream only runs while open — a whole-client grab costs ~350ms a frame,
 * which is fine for a setup mode and unacceptable as a permanent fixture.
 */
export function RegionSetup({ target, region, open, hint, onSelectRegion }: RegionSetupProps) {
  const stream = useFrameStream(target, { live: open && target !== undefined, intervalMs: 500 });

  return (
    <Reveal show={open}>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{hint}</p>
        {stream.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {stream.error}
          </p>
        )}
        <FramePreview
          bitmap={stream.bitmap}
          sourceRect={stream.handle?.source}
          highlight={region}
          onSelectRegion={onSelectRegion}
          className="max-h-72"
        />
      </div>
    </Reveal>
  );
}
