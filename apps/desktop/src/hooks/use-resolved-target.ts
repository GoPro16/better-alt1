import {
  type CaptureTarget,
  type ResolutionVia,
  describeTarget,
  resolveTarget,
} from "@better-alt1/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { captureTargetsKey, useCaptureTargets } from "@/hooks/use-capture";
import { useSettings } from "@/hooks/use-settings";
import { isUnknownTargetError } from "@/lib/capture";

/** Re-enumeration cadence while nothing resolves — covers launching the game after the
 * app. Enumeration runs on the backend's blocking pool, so this is cheap to keep up. */
const SEARCH_INTERVAL_MS = 5_000;

/** Floor between failure-triggered re-enumerations, so an erroring watch loop ticking
 * every second does not turn into an enumeration loop. */
const REPORT_THROTTLE_MS = 3_000;

const NO_TARGETS: CaptureTarget[] = [];

export interface ResolvedTarget {
  /** The live target the persisted descriptor resolves to, if any. */
  target: CaptureTarget | undefined;
  via: ResolutionVia | undefined;
  targets: readonly CaptureTarget[];
  isLoading: boolean;
  isRefreshing: boolean;
  /** Manual override; persists a durable descriptor, not the bare id. */
  select: (target: CaptureTarget) => void;
  refresh: () => void;
  /** Feed capture failures here; a stale-id error triggers re-enumeration (throttled),
   * which is how a game restart heals without user action. */
  reportCaptureError: (cause: unknown) => void;
}

/**
 * The one way pages should obtain a capture target.
 *
 * Persisted target ids are window handles that die with the window, so this hook stores a
 * `TargetDescriptor` and re-resolves it against enumeration every render: exact id → same
 * title/app name (restarted client) → detected game client → nothing. While unresolved it
 * keeps re-enumerating, so "start the app, then the game" needs no clicks.
 */
export function useResolvedTarget(
  options: {
    /** Keep re-enumerating even while resolved, so target bounds stay fresh — needed by
     * anything that follows the window around, like the pinned overlay. */
    follow?: boolean;
  } = {},
): ResolvedTarget {
  const { settings, update, loaded } = useSettings();
  const client = useQueryClient();
  const lastReportRef = useRef(0);

  // Resolution waits for settings to load: resolving against the default (empty)
  // descriptor first would auto-pick before the user's stored choice has a say.
  const descriptor = loaded ? settings.target : undefined;

  // Whether to keep polling has to be decided before useQuery runs, so peek at the cache;
  // any data change re-renders and re-evaluates this, so it never stays stale.
  const cached = client.getQueryData<CaptureTarget[]>(captureTargetsKey);
  const unresolved = loaded && resolveTarget(descriptor, cached ?? NO_TARGETS) === undefined;
  const query = useCaptureTargets({
    refetchInterval: unresolved || options.follow ? SEARCH_INTERVAL_MS : false,
  });

  const targets = query.data ?? NO_TARGETS;
  const resolution = loaded ? resolveTarget(descriptor, targets) : undefined;

  // Write back what resolution found: the fresh id becomes next render's fast path, and a
  // heuristic find records title/appName for the next restart. `via === "id"` means the
  // stored descriptor already points at this exact target — nothing to write.
  useEffect(() => {
    if (!loaded || !resolution || resolution.via === "id") return;
    if (settings.target?.id === resolution.target.id) return;
    update({ ...settings, target: describeTarget(resolution.target) });
  }, [loaded, resolution, settings, update]);

  const select = useCallback(
    (target: CaptureTarget) => update({ ...settings, target: describeTarget(target) }),
    [settings, update],
  );

  const refetch = query.refetch;
  const refresh = useCallback(() => void refetch(), [refetch]);

  const reportCaptureError = useCallback(
    (cause: unknown) => {
      if (!isUnknownTargetError(cause)) return;
      const now = performance.now();
      if (now - lastReportRef.current < REPORT_THROTTLE_MS) return;
      lastReportRef.current = now;
      void client.invalidateQueries({ queryKey: captureTargetsKey });
    },
    [client],
  );

  return {
    target: resolution?.target,
    via: resolution?.via,
    targets,
    isLoading: query.isLoading || !loaded,
    isRefreshing: query.isFetching,
    select,
    refresh,
    reportCaptureError,
  };
}
