import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";

/** Base window size at 100% scale; everything inside is rem-based, so scaling the root
 * font-size scales the entire layout with it. */
const BASE_WIDTH = 420;
const BASE_HEIGHT = 580;

/**
 * Apply a UI scale: root font-size drives the layout, and the window grows to match.
 * The window stays `resizable: false` (no resize cursors, no 1px drag jiggle) and is
 * unlocked only for the instant of the programmatic resize, because Windows ignores
 * `setSize` on a non-resizable window.
 */
export function applyUiScale(scale: number) {
  document.documentElement.style.fontSize = `${scale * 100}%`;

  const size = new LogicalSize(Math.round(BASE_WIDTH * scale), Math.round(BASE_HEIGHT * scale));
  const window = getCurrentWindow();
  void window
    .setResizable(true)
    .then(() => window.setSize(size))
    .then(() => window.setResizable(false))
    .catch(() => undefined);
}
