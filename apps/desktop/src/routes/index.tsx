import type { Rect } from "@better-alt1/core";
import { createFileRoute } from "@tanstack/react-router";
import {
  Crop,
  Loader2,
  PictureInPicture2,
  ScanSearch,
  Volume2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FeatureSection } from "@/components/feature-section";
import { RegionSetup } from "@/components/region-setup";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAfkWatch } from "@/hooks/use-afk-watch";
import { useInventoryWatch } from "@/hooks/use-inventory-watch";
import { useOverlay } from "@/hooks/use-overlay";
import { useResolvedTarget } from "@/hooks/use-resolved-target";
import { useSettings } from "@/hooks/use-settings";
import { type AfkConfig, clampIdleSeconds, loadAfkConfig, saveAfkConfig } from "@/lib/afk";
import { playClick, playToggle } from "@/lib/alert";
import { captureFrame, frameDetectSlots, frameRelease } from "@/lib/capture";
import { features } from "@/lib/features";
import type { OverlayStatus } from "@/lib/overlay";
import {
  type InventoryConfig,
  SLOT_COUNT,
  loadInventoryConfig,
  saveInventoryConfig,
} from "@/lib/inventory";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: WatchPage,
});

/** Both watchers change slowly; polling faster just burns capture budget. */
const POLL_MS = 1000;

/** Which feature's region picker is open; its whole-target preview stream pauses every
 * watch loop, so only one can be open and nothing scans meanwhile. */
type SettingUp = "inventory" | "afk" | null;

function WatchPage() {
  const { settings, update } = useSettings();
  const [config, setConfig] = useState<InventoryConfig>(loadInventoryConfig);
  const [afk, setAfk] = useState<AfkConfig>(loadAfkConfig);
  // Follow while the overlay is up: it is pinned to the client's bounds, which only stay
  // fresh if enumeration keeps running.
  const resolved = useResolvedTarget({ follow: config.overlay && config.enabled });
  const [settingUp, setSettingUp] = useState<SettingUp>(null);

  useEffect(() => saveInventoryConfig(config), [config]);
  useEffect(() => saveAfkConfig(afk), [afk]);

  const target = resolved.target;

  const watch = useInventoryWatch({
    targetId: target?.id,
    targetBounds: target?.bounds,
    region: settings.region,
    config,
    // The setup preview streams whole-target grabs; running the watch alongside it would
    // have the two capture loops starving each other.
    enabled: config.enabled && settings.region !== undefined && settingUp === null,
    intervalMs: POLL_MS,
    onCaptureError: resolved.reportCaptureError,
  });

  const afkWatch = useAfkWatch({
    targetId: target?.id,
    config: afk,
    enabled: features.afkWarden && afk.enabled && settingUp === null,
    intervalMs: POLL_MS,
    onCaptureError: resolved.reportCaptureError,
  });

  const ready = target !== undefined && settings.region !== undefined;

  const overlayStatus: Omit<OverlayStatus, "region" | "chip"> = {
    watching: config.enabled && settingUp === null,
    freeCount: watch.freeCount,
    occupied: watch.occupied,
    alerting: watch.alerting,
  };
  useOverlay({
    enabled: config.overlay && config.enabled,
    target,
    region: settings.region,
    status: overlayStatus,
  });

  // The region was drawn against a target this size; a mismatch means it now reads the
  // wrong pixels — silently, so warn rather than let the scan lie.
  const staleRegion = (drawnAt: { width: number; height: number } | undefined) =>
    target !== undefined &&
    drawnAt !== undefined &&
    (drawnAt.width !== target.bounds.width || drawnAt.height !== target.bounds.height);

  // Real slot cells measure ~50-110px; a region whose implied cells are under 24px is a
  // stale or mis-drawn selection, which otherwise just reads "28 free" forever.
  const regionTooSmall =
    settings.region !== undefined &&
    (settings.region.width / watch.columns < 24 || settings.region.height / watch.rows < 24);

  const targetWidth = target?.bounds.width;
  const targetHeight = target?.bounds.height;

  const onSelectInventoryRegion = useCallback(
    (region: Rect) => {
      update({
        ...settings,
        region,
        targetSize:
          targetWidth !== undefined && targetHeight !== undefined
            ? { width: targetWidth, height: targetHeight }
            : undefined,
      });
    },
    [settings, update, targetWidth, targetHeight],
  );

  const onSelectAfkRegion = useCallback(
    (region: Rect) =>
      setAfk((current) => ({
        ...current,
        region,
        targetSize:
          targetWidth !== undefined && targetHeight !== undefined
            ? { width: targetWidth, height: targetHeight }
            : undefined,
      })),
    [targetWidth, targetHeight],
  );

  const [finding, setFinding] = useState(false);
  const targetId = target?.id;
  const { reportCaptureError } = resolved;

  /** One native pass over a full-resolution grab; pixels never cross the boundary. */
  const findInventory = useCallback(async (): Promise<boolean> => {
    if (!targetId) return false;
    setFinding(true);
    try {
      const handle = await captureFrame(targetId, {});
      try {
        const found = await frameDetectSlots(handle.id);
        if (!found) return false;
        onSelectInventoryRegion(found.region);
        toast.success("Found your inventory");
        return true;
      } finally {
        void frameRelease(handle.id).catch(() => undefined);
      }
    } catch (cause) {
      reportCaptureError(cause);
      return false;
    } finally {
      setFinding(false);
    }
  }, [targetId, onSelectInventoryRegion, reportCaptureError]);

  // Zero-click setup: while the feature is on with no area selected, keep trying to find
  // the inventory automatically. Throttled by the ref, so re-renders can't spam ~150ms
  // native scans.
  const lastAutoFindRef = useRef(0);
  useEffect(() => {
    if (!config.enabled || settings.region !== undefined || !targetId || settingUp !== null) {
      return;
    }
    const attempt = () => {
      const now = Date.now();
      if (now - lastAutoFindRef.current < 10_000) return;
      lastAutoFindRef.current = now;
      void findInventory();
    };
    attempt();
    const timer = setInterval(attempt, 10_000);
    return () => clearInterval(timer);
  }, [config.enabled, settings.region, targetId, settingUp, findInventory]);

  const idleSeconds =
    afkWatch.idleForMs === undefined ? undefined : Math.floor(afkWatch.idleForMs / 1000);

  return (
    <div className="space-y-3">
      {/* A found, healthy target says nothing at all — the target lives in Settings.
          Only the problem states earn a line here. */}
      <Reveal show={!target}>
        <div className="flex items-center gap-2 pb-1 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-muted-foreground" />
          {resolved.isLoading
            ? "Looking for your game client…"
            : "Game client not found — launch it, or pick a window in Settings."}
        </div>
      </Reveal>

      <Reveal show={target?.isMinimized === true}>
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          The client is minimised — there are no pixels to read.
        </p>
      </Reveal>

      <FeatureSection
        id="inventory-enabled"
        title="Inventory watch"
        status={
          config.enabled && watch.freeCount !== undefined ? (
            <span className={cn(watch.alerting && "count-alert font-medium")}>
              {watch.freeCount} free
            </span>
          ) : undefined
        }
        enabled={config.enabled}
        onEnabledChange={(enabled) => setConfig({ ...config, enabled })}
      >
        <Reveal show={!ready}>
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            It finds your inventory on screen by itself — make sure it's visible in the
            client, then go play. It alerts before the inventory fills.
          </p>
        </Reveal>

        <Reveal show={settings.region === undefined}>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={!target || finding}
              onClick={() => {
                playClick();
                void findInventory().then((found) => {
                  if (!found) {
                    toast.error("Couldn't find the inventory — is it visible in the client?");
                  }
                });
              }}
            >
              {finding ? <Loader2 className="animate-spin" /> : <ScanSearch />}
              {finding ? "Looking…" : "Find my inventory"}
            </Button>
            {settings.devTools && (
              <Button
                variant="ghost"
                disabled={!target}
                onClick={() => setSettingUp(settingUp === "inventory" ? null : "inventory")}
              >
                <Crop />
                {settingUp === "inventory" ? "cancel" : "select manually"}
              </Button>
            )}
          </div>
        </Reveal>

        <RegionSetup
          target={target}
          region={settings.region}
          open={settingUp === "inventory"}
          hint="Drag a box around your whole inventory slot grid. The current area is dashed."
          onSelectRegion={onSelectInventoryRegion}
        />

        <Reveal show={staleRegion(settings.targetSize) || regionTooSmall}>
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {regionTooSmall
              ? "The selected area is too small to be the inventory — run Find my inventory again."
              : "The client was resized since setup — run Find my inventory again."}
          </p>
        </Reveal>

        <Reveal show={watch.error !== undefined}>
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {watch.error}
          </p>
        </Reveal>

        <SlotGrid
          columns={watch.columns}
          occupied={watch.occupied}
          alerting={watch.alerting}
        />

        {(watch.lastScanMs !== undefined || (watch.unchangedForMs ?? 0) > 5000) && (
          <p className="text-right font-mono text-xs text-muted-foreground tabular-nums">
            {watch.lastScanMs !== undefined && `${watch.lastScanMs}ms`}
            {(watch.unchangedForMs ?? 0) > 5000 &&
              ` · ${Math.round((watch.unchangedForMs ?? 0) / 1000)}s idle`}
          </p>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Alert at
            <Input
              type="number"
              aria-label="Alert when free slots reach"
              min={0}
              max={SLOT_COUNT - 1}
              value={config.alertAtFree}
              onChange={(event) =>
                setConfig({
                  ...config,
                  alertAtFree: clamp(event.target.valueAsNumber, 0, SLOT_COUNT - 1),
                })
              }
              className="h-8 max-w-16 font-mono tabular-nums"
            />
            free
          </div>

          <div className="ml-auto flex items-center gap-1">
            {settings.devTools && settings.region !== undefined && (
              <IconToggle
                label="Adjust inventory area"
                pressed={settingUp === "inventory"}
                onToggle={(open) => setSettingUp(open ? "inventory" : null)}
              >
                <Crop className="size-4" />
              </IconToggle>
            )}
            <IconToggle
              label="Alert sound"
              pressed={config.sound}
              onToggle={(sound) => setConfig({ ...config, sound })}
            >
              <Volume2 className="size-4" />
            </IconToggle>
            <IconToggle
              label="Flash taskbar"
              pressed={config.flash}
              onToggle={(flash) => setConfig({ ...config, flash })}
            >
              <Zap className="size-4" />
            </IconToggle>
            <IconToggle
              label="Highlight on game"
              pressed={config.overlay}
              onToggle={(overlay) => setConfig({ ...config, overlay })}
            >
              <PictureInPicture2 className="size-4" />
            </IconToggle>
          </div>
        </div>
      </FeatureSection>

      {!features.afkWarden && (
        <section className="rounded-lg border border-dashed">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="text-sm font-semibold text-muted-foreground">AFK warden</span>
            <span className="ml-auto rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              coming soon
            </span>
          </div>
          <p className="border-t p-3 text-sm text-muted-foreground">
            Alarms when a watched area — your XP counter — stops changing. Still being
            tested against real play; it will light up in an upcoming release.
          </p>
        </section>
      )}

      {features.afkWarden && (
      <FeatureSection
        id="afk-enabled"
        title="AFK warden"
        status={
          afk.enabled && idleSeconds !== undefined ? (
            <span className={cn(afkWatch.alerting && "count-alert font-medium")}>
              idle {idleSeconds}s
            </span>
          ) : undefined
        }
        enabled={afk.enabled}
        onEnabledChange={(enabled) => setAfk({ ...afk, enabled })}
      >
        <Reveal show={afk.region === undefined}>
          <div className="space-y-3">
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Alarms when the selected area stops changing — you stopped fishing, the spot
              moved, or a dialog is up. Your XP counter is the ideal area to watch.
            </p>
            <Button
              className="w-full"
              disabled={!target}
              onClick={() => setSettingUp(settingUp === "afk" ? null : "afk")}
            >
              <Crop />
              {settingUp === "afk" ? "Cancel" : "Select area to watch"}
            </Button>
          </div>
        </Reveal>

        <RegionSetup
          target={target}
          region={afk.region}
          open={settingUp === "afk"}
          hint="Drag a tight box around your XP counter — it only changes when you gain xp. A box around your character works too."
          onSelectRegion={onSelectAfkRegion}
        />

        <Reveal show={staleRegion(afk.targetSize)}>
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            The client was resized since setup — reselect the watched area.
          </p>
        </Reveal>

        <Reveal show={afkWatch.error !== undefined}>
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {afkWatch.error}
          </p>
        </Reveal>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Alarm after
            <Input
              type="number"
              aria-label="Alarm after seconds idle"
              min={5}
              max={300}
              value={afk.idleAfterSeconds}
              onChange={(event) =>
                setAfk({ ...afk, idleAfterSeconds: clampIdleSeconds(event.target.valueAsNumber) })
              }
              className="h-8 max-w-20 font-mono tabular-nums"
            />
            s idle
          </div>

          <div className="ml-auto flex items-center gap-1">
            {afk.region !== undefined && (
              <IconToggle
                label="Adjust watched area"
                pressed={settingUp === "afk"}
                onToggle={(open) => setSettingUp(open ? "afk" : null)}
              >
                <Crop className="size-4" />
              </IconToggle>
            )}
            <IconToggle
              label="Alert sound"
              pressed={afk.sound}
              onToggle={(sound) => setAfk({ ...afk, sound })}
            >
              <Volume2 className="size-4" />
            </IconToggle>
            <IconToggle
              label="Flash taskbar"
              pressed={afk.flash}
              onToggle={(flash) => setAfk({ ...afk, flash })}
            >
              <Zap className="size-4" />
            </IconToggle>
          </div>
        </div>
      </FeatureSection>
      )}
    </div>
  );
}

/** The live inventory, mirroring the client's actual column count. Pure display —
 * permanent items simply always read occupied, so there is nothing to configure here. */
function SlotGrid({
  columns,
  occupied,
  alerting,
}: {
  columns: number;
  occupied: boolean[] | undefined;
  alerting: boolean;
}) {
  return (
    <div className="flex justify-center">
      <div
        className={cn("slot-panel grid w-fit gap-1.5 rounded-lg p-2.5", alerting && "alert-ring")}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: SLOT_COUNT }, (_, index) => (
          <span
            // Slots are positional by nature; the index is the identity.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            data-filled={occupied?.[index] === true}
            className="slot-cell size-10 rounded-sm"
          />
        ))}
      </div>
    </div>
  );
}

function IconToggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={() => {
            playToggle(!pressed);
            onToggle(!pressed);
          }}
          className={cn(
            "inline-flex size-8 items-center justify-center rounded-md border transition-colors",
            pressed
              ? "border-primary/50 bg-accent text-accent-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {pressed ? "on" : "off"}
      </TooltipContent>
    </Tooltip>
  );
}

function clamp(value: number, low: number, high: number) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}
