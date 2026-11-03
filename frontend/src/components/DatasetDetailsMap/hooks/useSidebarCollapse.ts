import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "dt-dataset-sidebar-collapsed";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Collapsed state of the dataset info sidebar: remembered between visits, toggled with I, and
 * folded away while editing so the map gets the room (restored when editing ends).
 */
export function useSidebarCollapse(isEditing: boolean) {
  const [collapsed, setCollapsed] = useState(readStored);
  const beforeEditRef = useRef<boolean | null>(null);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Storage can be blocked; the toggle still works for this visit.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (isEditing) {
      beforeEditRef.current = collapsed;
      setCollapsed(true);
    } else if (beforeEditRef.current !== null) {
      setCollapsed(beforeEditRef.current);
      beforeEditRef.current = null;
    }
    // Only an edit start or end moves the sidebar; `collapsed` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

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
