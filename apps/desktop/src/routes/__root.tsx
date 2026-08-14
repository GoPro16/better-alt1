import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { Eye } from "lucide-react";
import { useEffect } from "react";
import { PinButton } from "@/components/pin-button";
import { WindowControls } from "@/components/window-controls";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/use-settings";
import { applyUiScale } from "@/lib/scale";
import { checkForUpdate } from "@/lib/updater";
import { cn } from "@/lib/utils";

export const Route = createRootRoute({
  component: RootLayout,
});

const NAV = [
  { to: "/", label: "Watch" },
  { to: "/settings", label: "Settings" },
] as const;

function RootLayout() {
  const { settings, loaded } = useSettings();

  // Root font-size scales the whole rem-based layout; the window is resized to match.
  useEffect(() => {
    if (loaded) applyUiScale(settings.uiScale);
  }, [loaded, settings.uiScale]);

  // One passive check per launch; no-op in dev and when offline.
  useEffect(() => {
    void checkForUpdate();
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        {/* The window is undecorated (tauri.conf.json), so this header IS the
            titlebar. data-tauri-drag-region only makes the element it sits on
            draggable — not its children — so it is repeated on the static text. */}
        <header data-tauri-drag-region className="flex items-center gap-4 py-2 pr-2 pl-4">
          <div data-tauri-drag-region className="flex items-center gap-2">
            <Eye className="pointer-events-none size-4 text-primary" />
            <span
              data-tauri-drag-region
              className="bg-gradient-to-b from-primary to-primary/60 bg-clip-text text-sm font-semibold tracking-tight text-transparent"
            >
              better-alt1
            </span>
          </div>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                )}
                activeProps={{ className: "bg-accent text-accent-foreground" }}
                activeOptions={{ exact: item.to === "/" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto" />

          <PinButton />
          <WindowControls />
        </header>

        {/* A gilded hairline under the titlebar instead of a flat gray separator. */}
        <div className="h-px shrink-0 bg-gradient-to-r from-transparent via-primary/35 to-transparent" />

        {/* The window is fixed-size; the page scrolls inside it (slim scrollbar in
            styles.css) instead of the window ever growing scrollbars of its own. */}
        <main className="flex-1 overflow-y-auto p-3">
          <Outlet />
        </main>
      </div>

      <Toaster theme="dark" />

      {/* Opt-in via `VITE_DEVTOOLS=1 pnpm dev`. These panels subscribe to every router
          and query update, so they are a real cost when profiling the capture loop —
          off by default so they cannot be mistaken for the app being slow. */}
      {import.meta.env.DEV && import.meta.env.VITE_DEVTOOLS === "1" && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools buttonPosition="bottom-right" />
        </>
      )}
    </TooltipProvider>
  );
}
