import { useCallback, useEffect, useState } from "react";

function readStored(storageKey: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

/**
 * Collapsed state of a map page's side panel: remembered between visits under `storageKey`
 * and toggled with the I key.
 */
export function useSidebarCollapse(storageKey: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(() => readStored(storageKey, defaultCollapsed));

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // Storage can be blocked; the toggle still works for this visit.
      }
      return next;
    });
  }, [storageKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed, toggle };
}
