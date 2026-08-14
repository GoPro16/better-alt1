import { type CaptureTarget, type Rect, formatSignature } from "@better-alt1/core";
import { Camera, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FramePreview } from "@/components/frame-preview";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useFrameStream } from "@/hooks/use-capture";
import { useDiagnostics } from "@/hooks/use-diagnostics";
import { useResolvedTarget } from "@/hooks/use-resolved-target";
import { useSettings } from "@/hooks/use-settings";
import { type IpcBenchmark, measureIpc } from "@/lib/ipc-benchmark";

/**
 * The measurement bench: frame timings, transport health, the IPC benchmark the capture
 * docs tell you to re-run before raising any size limit, and a raw preview with the
 * drag-to-set-region picker. Mount it only while open — its live stream is a real capture
 * loop. It can't contend with the watch loop: the watch lives on the home route, which is
 * unmounted while Settings is on screen.
 */
export function CaptureDiagnostics() {
  const { settings, update } = useSettings();
  const resolved = useResolvedTarget();
  const diagnostics = useDiagnostics();
  const [live, setLive] = useState(false);

  const selected = resolved.target;

  const stream = useFrameStream(selected, {
    live,
    intervalMs: settings.intervalMs,
    region: settings.region,
  });

  // A stale-id failure mid-stream (the client restarted) triggers re-enumeration, which
  // resolution turns back into a live target without the user touching anything.
  const { reportCaptureError } = resolved;
  useEffect(() => {
    if (stream.error) reportCaptureError(stream.error);
  }, [stream.error, reportCaptureError]);

  // Authoritative, from the backend: the target-local area the frame covers. Do not
  // substitute `selected.bounds` — those are virtual-desktop coordinates, and a client on a
  // display above the primary has a negative origin, which produced regions that could
  // never overlap the target.
  const sourceRect = stream.handle?.source;

  const onSelectRegion = useCallback(
    (region: Rect) =>
      update({
        ...settings,
        region,
        // Recorded so a later resize of the target is detectable as "region is stale".
        targetSize: selected
          ? { width: selected.bounds.width, height: selected.bounds.height }
          : undefined,
      }),
    [settings, update, selected],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={stream.grabOnce} disabled={!selected}>
          <Camera />
          Capture once
        </Button>

        <div className="flex items-center gap-2">
          <Switch id="live" checked={live} disabled={!selected} onCheckedChange={setLive} />
          <Label htmlFor="live" className="text-muted-foreground">
            Live · every {settings.intervalMs}ms
          </Label>
        </div>

        {settings.region && (
          <Button
            variant="outline"
            onClick={() => update({ ...settings, region: undefined, targetSize: undefined })}
          >
            <Maximize2 />
            Whole target
          </Button>
        )}
      </div>

      {!settings.region && selected && (
        <p className="text-xs text-muted-foreground">
          Capturing the whole {selected.bounds.width}×{selected.bounds.height} target costs
          ~350ms per frame. Drag a box on the preview to pick just the part you care about —
          a region that size grabs in ~25ms.
        </p>
      )}

      {stream.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {stream.error}
        </p>
      )}

      {/* Makes "I clicked it and nothing happened" diagnosable: if Capture is a no-op
          the reason is almost always no selection or a still-loading target list. */}
      <p className="font-mono text-xs text-muted-foreground">
        {resolved.isLoading ? "enumerating targets…" : `${resolved.targets.length} targets`}
        {" · "}
        {selected ? `selected ${selected.id}` : "nothing selected — Capture is disabled"}
        {stream.handle ? ` · frame #${stream.handle.id}` : " · no frame yet"}
      </p>

      <FrameStats stream={stream} target={selected} region={settings.region} />
      <HealthLine stream={stream} diagnostics={diagnostics} />
      <FramePreview bitmap={stream.bitmap} sourceRect={sourceRect} onSelectRegion={onSelectRegion} />
    </div>
  );
}

function FrameStats({
  stream,
  target,
  region,
}: {
  stream: ReturnType<typeof useFrameStream>;
  target: CaptureTarget | undefined;
  region: Rect | undefined;
}) {
  const { handle } = stream;
  const { fps, lastGrabMs, frameCount, signature, staleFrames, previewKib, nativeKib } =
    stream.stats;
  if (!handle) return null;

  // Compare against what was actually asked for. Comparing a region crop against the
  // whole target reports a "downscale" that never happened.
  const requested = region ?? target?.bounds;
  const downscale = requested ? requested.width / handle.width : 1;

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
      <Stat label="frame">
        {handle.width}×{handle.height}
      </Stat>
      {requested && (
        <Stat label={region ? "region" : "target"}>
          {requested.width}×{requested.height}
          {downscale > 1.01 && ` (1/${downscale.toFixed(1)})`}
        </Stat>
      )}
      {region && target && (
        <Stat label="within">
          {target.bounds.width}×{target.bounds.height}
        </Stat>
      )}
      {/* The whole point of the handle model: native size stays in Rust, only the encoded
          preview crosses the boundary. */}
      <Stat label="sent">
        {previewKib} KiB <span className="opacity-60">of {nativeKib} KiB native</span>
      </Stat>
      {lastGrabMs !== undefined && <Stat label="grab">{lastGrabMs}ms</Stat>}
      <Stat label="fps">{fps}</Stat>
      <Stat label="frames">{frameCount}</Stat>
      {/* If frames climb but the fingerprint never moves, capture is fine and the screen
          region is genuinely static — indistinguishable by eye from a dead preview. */}
      {signature !== undefined && (
        <Stat label="content">
          {formatSignature(signature)}
          {staleFrames > 0 && ` (unchanged ×${staleFrames})`}
        </Stat>
      )}
      <Stat label="at">{new Date(handle.capturedAt).toLocaleTimeString()}</Stat>
    </dl>
  );
}

/**
 * Separates the three things that all present as "the app is slow": a slow grab, a
 * blocked main thread, and a growing heap. Without splitting them apart there is nothing
 * to act on.
 */
function HealthLine({
  stream,
  diagnostics,
}: {
  stream: ReturnType<typeof useFrameStream>;
  diagnostics: ReturnType<typeof useDiagnostics>;
}) {
  const { worstGrabMs, worstCaptureMs, worstPreviewMs } = stream.stats;
  const {
    worstLongTaskMs,
    longTaskCount,
    worstTimerGapMs,
    focused,
    samplingSuspended,
    heapUsedMb,
    heapLimitMb,
  } = diagnostics;
  const [ipc, setIpc] = useState<IpcBenchmark>();
  const [measuring, setMeasuring] = useState(false);

  const runIpcTest = async () => {
    setMeasuring(true);
    try {
      setIpc(await measureIpc());
    } finally {
      setMeasuring(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border border-dashed p-2.5 font-mono text-xs tabular-nums">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <Metric label="worst grab" value={`${worstGrabMs}ms`} bad={worstGrabMs > 1500} />
        <Metric label="native capture" value={`${worstCaptureMs}ms`} bad={worstCaptureMs > 500} />
        <Metric label="preview path" value={`${worstPreviewMs}ms`} bad={worstPreviewMs > 300} />
        {/* The trustworthy blocking signal: reported by the browser, immune to the timer
            throttling that unfocused windows suffer. */}
        <Metric
          label="longest task"
          value={`${worstLongTaskMs}ms${longTaskCount > 0 ? ` ×${longTaskCount}` : ""}`}
          bad={worstLongTaskMs > 200}
        />
        <Metric
          label="timer gap"
          value={samplingSuspended ? "paused (unfocused)" : `${worstTimerGapMs}ms`}
          bad={!samplingSuspended && worstTimerGapMs > 500}
        />
        <Metric label="focus" value={focused ? "yes" : "no"} />
        {heapUsedMb !== undefined && (
          <Metric
            label="heap"
            value={`${heapUsedMb.toFixed(0)}${heapLimitMb === undefined ? "" : ` / ${heapLimitMb.toFixed(0)}`} MiB`}
          />
        )}
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={diagnostics.reset}>
          reset
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {ipc && (
          <Metric
            label="IPC alone"
            value={`${ipc.mibPerSecond.toFixed(1)} MiB/s (${ipc.measurements
              .map((m) => `${m.kib}K:${m.ms}ms`)
              .join(" ")})`}
            bad={ipc.mibPerSecond < 20}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          disabled={measuring}
          onClick={() => void runIpcTest()}
        >
          {measuring ? "measuring…" : "test IPC alone"}
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <span className="text-muted-foreground">
      <span className="opacity-60">{label} </span>
      <span className={bad ? "text-destructive" : "text-foreground"}>{value}</span>
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt className="opacity-60">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
