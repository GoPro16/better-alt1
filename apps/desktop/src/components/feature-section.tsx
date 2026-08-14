import { Reveal } from "@/components/reveal";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { playToggle } from "@/lib/alert";

/**
 * A feature the user can turn off and forget: header row with the switch, body only
 * while enabled. The switch state is the caller's to persist — a feature left on should
 * come back on at the next launch.
 */
export function FeatureSection({
  id,
  title,
  status,
  enabled,
  onEnabledChange,
  children,
}: {
  id: string;
  title: string;
  /** Compact live readout shown beside the switch — "21 free", "idle 47s". */
  status?: React.ReactNode;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Label htmlFor={id} className="text-sm font-semibold">
          {title}
        </Label>
        <div className="ml-auto flex items-center gap-3">
          {status !== undefined && (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {status}
            </span>
          )}
          <Switch
            id={id}
            checked={enabled}
            onCheckedChange={(next) => {
              // Also the gesture that unblocks audio playback for later alerts.
              playToggle(next);
              onEnabledChange(next);
            }}
          />
        </div>
      </div>
      <Reveal show={enabled}>
        <div className="space-y-3 border-t p-3">{children}</div>
      </Reveal>
    </section>
  );
}
