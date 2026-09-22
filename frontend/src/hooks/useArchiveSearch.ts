import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSemanticSearch } from "./useSemanticSearch";

export type ArchiveSearchMode = "text" | "ai";

// URL state keeps mode/query together across links and browser history. An old
// AI request belongs to its own actor/query cache and cannot filter text mode.
export function useArchiveSearch() {
  const [params, setParams] = useSearchParams();
  const mode: ArchiveSearchMode =
    params.has("q") || params.get("search") === "ai" ? "ai" : "text";
  const semantic = useSemanticSearch(mode === "ai");
  const text = mode === "text" ? params.get("text") ?? "" : "";
  const [draft, setDraft] = useState(semantic.query ?? "");
  useEffect(() => setDraft(semantic.query ?? ""), [semantic.query, mode]);

  const changeMode = (nextMode: ArchiveSearchMode) => {
    if (nextMode === mode) return;
    setDraft("");
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("q");
      next.delete("text");
      if (nextMode === "ai") next.set("search", "ai");
      else next.delete("search");
      return next;
    });
  };

  const changeInput = (value: string) => {
    if (mode === "ai") {
      setDraft(value);
      if (!value) setParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("q");
        next.set("search", "ai");
        return next;
      });
    } else {
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("q");
        next.delete("search");
        if (value) next.set("text", value);
        else next.delete("text");
        return next;
      }, { replace: true });
    }
  };

  return { mode, changeMode, input: mode === "ai" ? draft : text,
    changeInput, text, semantic };
}
