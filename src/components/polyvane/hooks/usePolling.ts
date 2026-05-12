import { useEffect, useRef } from "react";

interface UsePollingOptions {
  intervalMs: number;
  enabled?: boolean;
  immediate?: boolean;
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;

export function usePolling(
  fn: () => Promise<unknown> | unknown,
  { intervalMs, enabled = true, immediate = true }: UsePollingOptions,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;

    const computeDelay = () => {
      if (consecutiveErrors === 0) return intervalMs;
      const backoff = intervalMs * Math.pow(2, consecutiveErrors - 1);
      return Math.min(backoff, MAX_BACKOFF_MS);
    };

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        timeoutId = setTimeout(tick, intervalMs);
        return;
      }
      try {
        await fnRef.current();
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors = Math.min(consecutiveErrors + 1, 6);
      }
      if (!cancelled) {
        timeoutId = setTimeout(tick, computeDelay());
      }
    };

    if (immediate) {
      void tick();
    } else {
      timeoutId = setTimeout(tick, intervalMs);
    }

    const onVisibility = () => {
      if (!document.hidden && timeoutId !== null) {
        clearTimeout(timeoutId);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, immediate]);
}
