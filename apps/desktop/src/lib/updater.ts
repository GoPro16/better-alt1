import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";

/**
 * Ask the release endpoint whether a newer version exists, and offer it as a toast.
 * Never throws to the caller: being offline or the endpoint missing is a normal state
 * for a passive check, not something to interrupt the user over.
 */
export async function checkForUpdate() {
  if (import.meta.env.DEV) return;

  let update: Update | null;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;

  toast(`Update ${update.version} available`, {
    duration: Infinity,
    action: {
      label: "Install & restart",
      onClick: () => void install(update),
    },
  });
}

async function install(update: Update) {
  const id = toast.loading("Downloading update…");
  try {
    // Download + install run natively; `passive` install mode (tauri.conf.json) shows
    // the installer's own progress bar, then relaunch brings the new version up.
    await update.downloadAndInstall();
    toast.success("Installed — restarting…", { id });
    await relaunch();
  } catch (error) {
    toast.error(`Update failed: ${String(error)}`, { id });
  }
}
