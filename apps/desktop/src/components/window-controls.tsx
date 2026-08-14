import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";

const win = getCurrentWindow();

const buttonClass =
  "inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export function WindowControls() {
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label="Minimize" className={buttonClass} onClick={() => win.minimize()}>
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Close"
        className="inline-flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => win.close()}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
