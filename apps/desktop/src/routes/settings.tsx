import { getVersion } from "@tauri-apps/api/app";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { Bug, ChevronDown, ChevronRight, Lightbulb } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { reportBug, requestFeature } from "@/lib/bug-report";
import { CaptureDiagnostics } from "@/components/capture-diagnostics";
import { TargetPicker } from "@/components/target-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useResolvedTarget } from "@/hooks/use-resolved-target";
import { useSettings } from "@/hooks/use-settings";
import { playAlertSound } from "@/lib/alert";
import {
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  clampSensitivity,
  loadInventoryConfig,
  saveInventoryConfig,
} from "@/lib/inventory";
import {
  type AlertTone,
  type CaptureSettings,
  DEFAULT_SETTINGS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  UI_SCALES,
} from "@/lib/settings";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { settings, update, loaded } = useSettings();

  // Mount the form only once stored values are in hand, so defaultValues are correct
  // and we never have to reset mid-edit.
  if (!loaded) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <TargetCard />
      <SettingsForm initial={settings} onSave={update} />
      <DevToolsToggle
        enabled={settings.devTools}
        onChange={(devTools) => update({ ...settings, devTools })}
      />
      {settings.devTools && <DiagnosticsCard />}
      <AboutCard />
    </div>
  );
}

/** Version readout and the feedback exits. The bug button opens the GitHub issue form
 * with version and display environment prefilled — the fields users misreport most. */
function AboutCard() {
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(undefined));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">About</CardTitle>
        <CardDescription>
          better-alt1 {version ?? ""} — it observes, it never acts.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void reportBug()}>
          <Bug />
          Report a bug
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void requestFeature()}>
          <Lightbulb />
          Request a feature
        </Button>
      </CardContent>
    </Card>
  );
}

/** Manual region tools and diagnostics are debugging aids, not the shipped path —
 * auto-detect covers setup. Off by default so the everyday UI stays minimal. */
function DevToolsToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 px-1">
      <Switch id="dev-tools" checked={enabled} onCheckedChange={onChange} />
      <div className="space-y-0.5">
        <Label htmlFor="dev-tools">Developer tools</Label>
        <p className="text-xs text-muted-foreground">
          Shows manual region selection on the Watch page and capture diagnostics here.
        </p>
      </div>
    </div>
  );
}

/** Manual override for what gets captured. The watch page auto-detects the game client;
 * this exists for the cases the heuristic can't cover (unusual client names, monitors). */
function TargetCard() {
  const resolved = useResolvedTarget();

  const { targets, select } = resolved;
  const onSelect = useCallback(
    (id: string) => {
      const target = targets.find((t) => t.id === id);
      if (target) select(target);
    },
    [targets, select],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Capture target</CardTitle>
        <CardDescription>Found automatically; override it here if needed.</CardDescription>
      </CardHeader>
      <CardContent>
        <TargetPicker
          targets={targets}
          selectedId={resolved.target?.id}
          onSelect={onSelect}
          onRefresh={resolved.refresh}
          isRefreshing={resolved.isRefreshing}
        />
      </CardContent>
    </Card>
  );
}

interface FormValues {
  intervalMs: number;
}

function SettingsForm({
  initial,
  onSave,
}: {
  initial: CaptureSettings;
  onSave: (next: CaptureSettings) => void;
}) {
  const form = useForm({
    defaultValues: {
      intervalMs: initial.intervalMs,
    } satisfies FormValues,
    onSubmit: ({ value }) => {
      // The region and its calibration are owned by the Watch page's setup flow; the
      // spread deliberately carries them through untouched.
      onSave({
        ...initial,
        intervalMs: value.intervalMs,
      });
      toast.success("Settings saved");
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
          <CardDescription>Watch behaviour and capture pacing.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <SoundAndScaleFields />

          <ToleranceField />

          <form.Field
            name="intervalMs"
            validators={{
              onChange: ({ value }) => {
                if (!Number.isFinite(value)) return "Enter a number of milliseconds.";
                if (value < MIN_INTERVAL_MS) return `Minimum is ${MIN_INTERVAL_MS}ms.`;
                if (value > MAX_INTERVAL_MS) return `Maximum is ${MAX_INTERVAL_MS}ms.`;
                return undefined;
              },
            }}
          >
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>Diagnostics capture interval (ms)</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="number"
                  min={MIN_INTERVAL_MS}
                  max={MAX_INTERVAL_MS}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.valueAsNumber)}
                  className="max-w-40 font-mono tabular-nums"
                />
                <FieldError errors={field.state.meta.errors} />
                <p className="text-xs text-muted-foreground">
                  Pacing for the live preview in Capture diagnostics below. Lower is more
                  responsive and more CPU; a grab that overruns the interval drops that
                  frame rather than queueing.
                </p>
              </div>
            )}
          </form.Field>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              Save
            </Button>
          )}
        </form.Subscribe>

        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            form.reset({
              intervalMs: DEFAULT_SETTINGS.intervalMs,
            });
          }}
        >
          Reset to defaults
        </Button>
      </div>
    </form>
  );
}

/** Immediate-save fields for sound and scale — no Save button needed, and the volume
 * slider previews the alert on release so adjusting doubles as the test. */
function SoundAndScaleFields() {
  const { settings, update } = useSettings();

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="volume">Alert volume</Label>
        <div className="flex items-center gap-3">
          <input
            id="volume"
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.volume * 100)}
            onChange={(event) => update({ ...settings, volume: Number(event.target.value) / 100 })}
            onPointerUp={() => playAlertSound()}
            className="w-48"
            style={{ accentColor: "var(--primary)" }}
          />
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {Math.round(settings.volume * 100)}%
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Alert tone</Label>
        <div className="flex gap-2">
          {(["bell", "chime", "horn"] as const).map((tone: AlertTone) => (
            <Button
              key={tone}
              type="button"
              size="sm"
              variant={settings.alertTone === tone ? "default" : "outline"}
              onClick={() => {
                // update() dispatches the settings event synchronously, so the preview
                // below already plays the newly chosen tone.
                update({ ...settings, alertTone: tone });
                playAlertSound();
              }}
            >
              {tone}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>UI scale</Label>
        <div className="flex gap-2">
          {UI_SCALES.map((scale) => (
            <Button
              key={scale}
              type="button"
              size="sm"
              variant={settings.uiScale === scale ? "default" : "outline"}
              onClick={() => update({ ...settings, uiScale: scale })}
            >
              {Math.round(scale * 100)}%
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Scales the whole app, window included.
        </p>
      </div>
    </>
  );
}

/**
 * Lives outside the TanStack form: sensitivity belongs to the inventory config in its
 * own localStorage blob, saved immediately on change. The watch page re-reads it on
 * mount, so a change here applies the next time that page is shown.
 */
function ToleranceField() {
  const [tolerance, setTolerance] = useState(() => loadInventoryConfig().tolerance);

  const onChange = (value: number) => {
    const clamped = clampSensitivity(value);
    setTolerance(clamped);
    saveInventoryConfig({ ...loadInventoryConfig(), tolerance: clamped });
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="tolerance">Empty sensitivity</Label>
      <Input
        id="tolerance"
        type="number"
        min={MIN_SENSITIVITY}
        max={MAX_SENSITIVITY}
        value={tolerance}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="max-w-28 font-mono tabular-nums"
      />
      <p className="text-xs text-muted-foreground">
        A slot reads as occupied when its contents vary more than this. Raise it if empty
        slots read as full (semi-transparent interfaces); lower it if faint items read as
        empty.
      </p>
    </div>
  );
}

/**
 * Collapsed by default, and the panel only mounts while open — its live preview is a real
 * capture loop, and an unopened settings page should cost nothing.
 */
function DiagnosticsCard() {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <div>
            <CardTitle className="text-base">Capture diagnostics</CardTitle>
            <CardDescription>
              Frame timing, capture health, the IPC benchmark, and a raw preview.
            </CardDescription>
          </div>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          <CaptureDiagnostics />
        </CardContent>
      )}
    </Card>
  );
}

function FieldError({ errors }: { errors: unknown[] }) {
  const message = errors.find((error) => typeof error === "string");
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
