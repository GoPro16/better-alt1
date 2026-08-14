import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell } from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CHIP_BAND,
  FRAME_BORDER,
  FRAME_MARGIN,
  OVERLAY_STALE_MS,
  OVERLAY_STATUS_EVENT,
  type OverlayStatus,
} from "@/lib/overlay";
import { cn } from "@/lib/utils";
import "../styles.css";

/**
 * The overlay window: a click-through, always-on-top frame drawn around the watched
 * region in the game client, with a status chip outside it. Alt1-style: it highlights
 * exactly what is being read. The main window owns geometry and pushes status; this
 * renders and nothing more — no capture loop, no commands, no router.
 *
 * All incoming geometry is physical px; CSS px are physical / devicePixelRatio, and the
 * webview's ratio matches the monitor the window sits on.
 */
function OverlayFrame() {
  const [status, setStatus] = useState<OverlayStatus>();
  const [stale, setStale] = useState(false);
  const [dpr, setDpr] = useState(window.devicePixelRatio);
  const lastSeenRef = useRef(0);

  // Click-through: this overlay must never be the thing that steals a game click.
  useEffect(() => {
    void getCurrentWindow()
      .setIgnoreCursorEvents(true)
      .catch(() => undefined);
  }, []);

  // Fires on setSize and on monitor-scale changes; either can change the ratio.
  useEffect(() => {
    const onResize = () => setDpr(window.devicePixelRatio);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const unlisten = listen<OverlayStatus>(OVERLAY_STATUS_EVENT, (event) => {
      lastSeenRef.current = performance.now();
      setStatus(event.payload);
      setStale(false);
    });

    const staleTimer = setInterval(() => {
      setStale(performance.now() - lastSeenRef.current > OVERLAY_STALE_MS);
    }, 1_000);

    return () => {
      clearInterval(staleTimer);
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Nothing until the first heartbeat: the window may be shown a beat before main emits.
  if (!status?.region) return null;

  const px = (n: number) => n / dpr;
  const { region, chip } = status;
  const chipOffset = chip === "top" ? CHIP_BAND : 0;
  const dimmed = stale || !status.watching;

  const frameClass = status.alerting
    ? "border-destructive alert-ring"
    : status.watching && !stale
      ? "border-primary"
      : "border-muted-foreground/50";

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div
        className={cn("absolute border", frameClass, dimmed && "opacity-60")}
        style={{
          left: px(FRAME_MARGIN - FRAME_BORDER),
          top: px(chipOffset + FRAME_MARGIN - FRAME_BORDER),
          width: px(region.width + 2 * FRAME_BORDER),
          height: px(region.height + 2 * FRAME_BORDER),
          borderWidth: px(FRAME_BORDER),
        }}
      />

      <div
        className="absolute inset-x-0 flex items-center justify-center"
        style={{
          height: px(CHIP_BAND),
          top: chip === "top" ? 0 : undefined,
          bottom: chip === "bottom" ? 0 : undefined,
        }}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-primary/60 bg-black/85 px-2 py-0.5 text-xs",
            dimmed && "opacity-50",
          )}
        >
          <span
            className={cn(
              "uppercase tracking-wide",
              status.alerting
                ? "font-medium text-destructive"
                : status.watching && !stale
                  ? "text-primary"
                  : "text-muted-foreground",
            )}
          >
            {stale ? "no signal" : status.alerting ? "drop!" : status.watching ? "watching" : "paused"}
          </span>
          {status.freeCount !== undefined && (
            <span className="font-mono tabular-nums text-foreground">
              · {status.freeCount} free
            </span>
          )}
          {status.alerting && <Bell className="size-3 animate-pulse text-destructive" />}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from overlay.html");

createRoot(root).render(
  <StrictMode>
    <OverlayFrame />
  </StrictMode>,
);
