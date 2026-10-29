import { useEffect, useState } from "react";

export const SLOW_LOADING_AFTER_MS = 8000;

/** True once a wait has lasted long enough that the visitor deserves an explanation. */
export function useSlowLoading(afterMs = SLOW_LOADING_AFTER_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), afterMs);
    return () => window.clearTimeout(timer);
  }, [afterMs]);
  return slow;
}
