import { useCallback, useEffect, useState } from "react";

/** Chromium-only. Absent in other engines, so every read is guarded. */
interface HeapUsage {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readHeap(): HeapUsage | undefined {
  return (performance as Performance & { memory?: HeapUsage }).memory;
}

export interface Diagnostics {
  /**
   * Longest main-thread task, from the Long Tasks API. This is the number to trust: the
   * browser reports it directly, and it is unaffected by timer throttling.
   */
  worstLongTaskMs: number;
  longTaskCount: number;
  /**
   * Longest timer overshoot, sampled **only while the window is focused and visible**.
   * Kept as a cross-check on the Long Tasks number, which needs browser support.
   */
  worstTimerGapMs: number;
  /** Whether the window currently has focus. Metrics are only sampled when it does. */
  focused: boolean;
  /** True when timer sampling has been suspended because the window lost focus. */
  samplingSuspended: boolean;
  heapUsedMb: number | undefined;
  heapLimitMb: number | undefined;
  reset: () => void;
}

/**
 * Distinguishes the app genuinely blocking from the browser deprioritising it.
 *
 * The naive approach — measure how late an interval fires — is actively misleading here.
 * Chromium clamps timers in unfocused or occluded windows to roughly once a second, so
 * alt-tabbing to the game (which you must do for the game to render) fabricates a
 * ~750ms "stall" out of nothing. That false positive sent us chasing a phantom.
 *
 * So the primary signal is the Long Tasks API, which reports real main-thread work, and
 * timer sampling is gated on focus and reported separately.
 */
export function useDiagnostics(sampleMs = 250): Diagnostics {
  const [worstLongTaskMs, setWorstLongTaskMs] = useState(0);
  const [longTaskCount, setLongTaskCount] = useState(0);
  const [worstTimerGapMs, setWorstTimerGapMs] = useState(0);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [samplingSuspended, setSamplingSuspended] = useState(false);
  const [heap, setHeap] = useState<HeapUsage | undefined>(readHeap);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          setWorstLongTaskMs((worst) => Math.max(worst, Math.round(entry.duration)));
          setLongTaskCount((count) => count + 1);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long Tasks unsupported; the focus-gated timer sample is the fallback.
      return;
    }

    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const onFocusChange = () => setFocused(document.hasFocus());
    window.addEventListener("focus", onFocusChange);
    window.addEventListener("blur", onFocusChange);
    document.addEventListener("visibilitychange", onFocusChange);
    return () => {
      window.removeEventListener("focus", onFocusChange);
      window.removeEventListener("blur", onFocusChange);
      document.removeEventListener("visibilitychange", onFocusChange);
    };
  }, []);

  useEffect(() => {
    let expected = performance.now() + sampleMs;

    const id = setInterval(() => {
      const now = performance.now();
      const overshoot = now - expected;
      expected = now + sampleMs;

      setHeap(readHeap());

      // Throttled timers are not stalls. Discard the sample rather than report a lie.
      if (!document.hasFocus() || document.visibilityState !== "visible") {
        setSamplingSuspended(true);
        return;
      }
      setSamplingSuspended(false);

      // Ignore ordinary jitter; only real overshoot is interesting.
      if (overshoot > 50) {
        setWorstTimerGapMs((worst) => Math.max(worst, Math.round(overshoot)));
      }
    }, sampleMs);

    return () => clearInterval(id);
  }, [sampleMs]);

  const reset = useCallback(() => {
    setWorstLongTaskMs(0);
    setLongTaskCount(0);
    setWorstTimerGapMs(0);
  }, []);

  return {
    worstLongTaskMs,
    longTaskCount,
    worstTimerGapMs,
    focused,
    samplingSuspended,
    heapUsedMb: heap ? heap.usedJSHeapSize / 1_048_576 : undefined,
    heapLimitMb: heap ? heap.jsHeapSizeLimit / 1_048_576 : undefined,
    reset,
  };
}
