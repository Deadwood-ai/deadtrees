import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSemanticSearch } from "./useSemanticSearch";

export type ArchiveSearchMode = "text" | "ai";

// Long enough to skip the keystrokes of one typed word, short enough that the
// list and map still feel live once the visitor pauses.
export const ARCHIVE_TEXT_SEARCH_DEBOUNCE_MS = 250;

// URL state keeps mode/query together across links and browser history. An old
// AI request belongs to its own actor/query cache and cannot filter text mode.
//
// The field itself is driven by local state. Router updates run as low-priority
// transitions, so an input bound to the URL shows a stale value between
// keystrokes and drops what was typed. The URL (`text`, which filters the
// archive) follows the field after a short pause.
export function useArchiveSearch() {
  const [params, setParams] = useSearchParams();
  const mode: ArchiveSearchMode =
    params.has("q") || params.get("search") === "ai" ? "ai" : "text";
  const semantic = useSemanticSearch(mode === "ai");
  const text = mode === "text" ? params.get("text") ?? "" : "";
  const committed = mode === "ai" ? semantic.query ?? "" : text;
  const [input, setInput] = useState(committed);
  const pendingWrite = useRef<ReturnType<typeof setTimeout>>();

  const cancelPendingWrite = useCallback(() => {
    clearTimeout(pendingWrite.current);
    pendingWrite.current = undefined;
  }, []);
  useEffect(() => cancelPendingWrite, [cancelPendingWrite]);

  // Links and browser history change the URL from outside; the field follows.
  // While a write is pending the field is ahead of the URL, so it wins.
  useEffect(() => {
    if (pendingWrite.current === undefined) setInput(committed);
  }, [committed, mode]);

  const changeMode = (nextMode: ArchiveSearchMode) => {
    if (nextMode === mode) return;
    cancelPendingWrite();
    setInput("");
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("q");
      next.delete("text");
      if (nextMode === "ai") next.set("search", "ai");
      else next.delete("search");
      return next;
    });
  };

  const writeText = (value: string) => {
    cancelPendingWrite();
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("q");
      next.delete("search");
      if (value) next.set("text", value);
      else next.delete("text");
      return next;
    }, { replace: true });
  };

  const changeInput = (value: string) => {
    setInput(value);
    if (mode === "ai") {
      if (!value) setParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("q");
        next.set("search", "ai");
        return next;
      });
      return;
    }
    cancelPendingWrite();
    // Clearing the field clears the filter straight away.
    if (!value) writeText(value);
    else pendingWrite.current = setTimeout(
      () => writeText(value),
      ARCHIVE_TEXT_SEARCH_DEBOUNCE_MS,
    );
  };

  return { mode, changeMode, input, changeInput, text, semantic };
}
