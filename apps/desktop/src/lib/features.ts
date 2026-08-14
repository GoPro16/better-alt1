/**
 * Build-time feature gates. Dev builds see everything; a release build only ships what
 * has actually been tested against real play. Force a flag on for a one-off release
 * build with e.g. `VITE_FEATURE_AFK_WARDEN=1 pnpm build:app`; delete the flag here once
 * the feature has properly shipped.
 */
export const features = {
  /** Untested in real play sessions — shows as "coming soon" in release builds. */
  afkWarden: import.meta.env.DEV || import.meta.env.VITE_FEATURE_AFK_WARDEN === "1",
};
