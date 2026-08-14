import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listCaptureTargets } from "@/lib/capture";

const REPO = "https://github.com/GoPro16/better-alt1";

/**
 * Open the GitHub bug form with the environment fields prefilled — GitHub issue forms
 * accept a query param per field id (see .github/ISSUE_TEMPLATE/bug_report.yml).
 * Everything here is best-effort: a bug report must still open when capture itself is
 * the thing that is broken.
 */
export async function reportBug() {
  const params = new URLSearchParams({ template: "bug_report.yml" });

  try {
    params.set("version", await getVersion());
  } catch {
    /* leave the field for the user */
  }
  params.set("display", await describeDisplays());

  await openUrl(`${REPO}/issues/new?${params}`);
}

export async function requestFeature() {
  await openUrl(`${REPO}/issues/new?template=feature_request.yml`);
}

/** "3840x2160 + 2560x1440, scaling 125%, 2 monitors — Windows version: ___" */
async function describeDisplays() {
  const scaling = `scaling ${Math.round(window.devicePixelRatio * 100)}%`;
  const fillIn = "Windows version: ___";

  try {
    const monitors = (await listCaptureTargets()).filter((t) => t.kind === "monitor");
    if (monitors.length === 0) return `${scaling} — ${fillIn}`;
    const sizes = monitors.map((m) => `${m.bounds.width}x${m.bounds.height}`).join(" + ");
    const count = `${monitors.length} monitor${monitors.length === 1 ? "" : "s"}`;
    return `${sizes}, ${scaling}, ${count} — ${fillIn}`;
  } catch {
    return `${scaling} — ${fillIn}`;
  }
}
