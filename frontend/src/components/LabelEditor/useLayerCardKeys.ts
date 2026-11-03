import { useEffect, useRef } from "react";
import type { LayerView } from "./LayerCard";

interface UseLayerCardKeysParams {
  enabled: boolean;
  isEditing: boolean;
  onView: (view: LayerView) => void;
  onStartEdit: () => void;
  /** Called with true while Space is held, false when released. */
  onPeek: (peek: boolean) => void;
}

const VIEW_KEYS: Record<string, LayerView> = { "1": "imagery", "2": "deadwood", "3": "forest_cover", "4": "both" };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(target.type);
}

/**
 * Keys of the layer card. Exploring: 1 imagery, 2 deadwood, 3 tree cover, 4 both, E edit.
 * Editing, 2 and 3 belong to the editor (useDatasetEditing). Holding Space hides the labels in
 * both modes.
 */
export function useLayerCardKeys({ enabled, isEditing, onView, onStartEdit, onPeek }: UseLayerCardKeysParams) {
  // Handlers change every render; the listener reads the latest ones without re-subscribing.
  const handlers = useRef({ onView, onStartEdit, onPeek });
  useEffect(() => {
    handlers.current = { onView, onStartEdit, onPeek };
  });

  useEffect(() => {
    if (!enabled) return;
    let peeking = false;
    const stopPeek = () => {
      if (!peeking) return;
      peeking = false;
      handlers.current.onPeek(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        if (!peeking) {
          peeking = true;
          handlers.current.onPeek(true);
        }
        return;
      }
      if (e.repeat || isEditing) return;
      const view = VIEW_KEYS[e.key];
      if (view) {
        e.preventDefault();
        handlers.current.onView(view);
      } else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        handlers.current.onStartEdit();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") stopPeek();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopPeek);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopPeek);
      stopPeek();
    };
  }, [enabled, isEditing]);
}
