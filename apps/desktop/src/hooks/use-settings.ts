import { useCallback, useEffect, useState } from "react";
import {
  type CaptureSettings,
  DEFAULT_SETTINGS,
  SETTINGS_CHANGED_EVENT as CHANGED_EVENT,
  loadSettings,
  saveSettings,
} from "@/lib/settings";

/**
 * Settings live in localStorage, so every hook instance must hear about writes from any
 * other instance. A window event is enough — there is one renderer process.
 */
export function useSettings() {
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Read after mount so the first paint is not blocked on storage.
  useEffect(() => {
    setSettings(loadSettings());
    setLoaded(true);
  }, []);

  useEffect(() => {
    const onChanged = () => setSettings(loadSettings());
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, []);

  const update = useCallback((next: CaptureSettings) => {
    saveSettings(next);
    setSettings(next);
    window.dispatchEvent(new Event(CHANGED_EVENT));
  }, []);

  return { settings, update, loaded };
}
