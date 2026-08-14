import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PIN_KEY = "better-alt1.pinned";

/**
 * Keep the app above the game while playing — the companion-window half of feeling like
 * an Alt1 overlay. Persisted so the choice survives restarts.
 */
export function PinButton() {
  const [pinned, setPinned] = useState(() => localStorage.getItem(PIN_KEY) === "1");

  // Window state does not persist; re-apply the stored preference on startup. Mount-only —
  // toggling afterwards applies directly in the click handler.
  useEffect(() => {
    if (localStorage.getItem(PIN_KEY) === "1") {
      void getCurrentWindow().setAlwaysOnTop(true).catch(() => undefined);
    }
  }, []);

  const toggle = () => {
    const next = !pinned;
    setPinned(next);
    localStorage.setItem(PIN_KEY, next ? "1" : "0");
    void getCurrentWindow().setAlwaysOnTop(next).catch(() => undefined);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={pinned ? "Unpin from top" : "Keep on top"}
          aria-pressed={pinned}
          onClick={toggle}
          className={
            pinned
              ? "inline-flex h-7 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground transition-colors"
              : "inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          }
        >
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{pinned ? "Unpin from top" : "Keep on top of the game"}</TooltipContent>
    </Tooltip>
  );
}
