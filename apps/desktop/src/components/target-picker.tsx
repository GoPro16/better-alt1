import { type CaptureTarget, looksLikeGameClient } from "@better-alt1/core";
import { Monitor, RefreshCw, Star, AppWindow } from "lucide-react";
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TargetPickerProps {
  targets: readonly CaptureTarget[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

/**
 * Memoised: the capture loop updates state on every frame, and re-rendering a Radix
 * `Select` with a dozen items at capture rate is what made the dropdown feel sticky while
 * live. Callers must pass stable callbacks (`useCallback`) or this does nothing.
 */
export const TargetPicker = memo(function TargetPicker({
  targets,
  selectedId,
  onSelect,
  onRefresh,
  isRefreshing,
}: TargetPickerProps) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="capture-target">Capture target</Label>
        <Select value={selectedId ?? ""} onValueChange={onSelect} disabled={targets.length === 0}>
          <SelectTrigger id="capture-target" className="w-full">
            <SelectValue placeholder={targets.length === 0 ? "No targets found" : "Pick a target"} />
          </SelectTrigger>
          <SelectContent>
            {targets.map((target) => (
              <SelectItem key={target.id} value={target.id}>
                <span className="flex items-center gap-2">
                  {target.kind === "monitor" ? (
                    <Monitor className="size-3.5 shrink-0" />
                  ) : (
                    <AppWindow className="size-3.5 shrink-0" />
                  )}
                  {looksLikeGameClient(target) && (
                    <Star className="size-3.5 shrink-0 fill-current text-amber-500" />
                  )}
                  <span className="truncate">{target.title}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {target.bounds.width}×{target.bounds.height}
                  </span>
                  {target.isMinimized && (
                    <Badge variant="secondary" className="text-[10px]">
                      minimised
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button variant="outline" onClick={onRefresh} disabled={isRefreshing}>
        <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
        Refresh
      </Button>
    </div>
  );
});
