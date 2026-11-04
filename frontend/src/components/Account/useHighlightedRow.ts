import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/** Cell backgrounds, because Ant Design paints its fixed columns on the cell rather than the row. */
const HIGHLIGHTED_ROW_CLASS = "[&>td]:!bg-emerald-50";

/**
 * The dataset row named by `?highlight=` in a list: the table page that holds it,
 * its row props and one scroll into view per link. Anything but a listed id matches no row.
 */
export function useHighlightedRow(rowIds: number[], pageSize: number) {
  const [params] = useSearchParams();
  const highlightId = Number(params.get("highlight"));
  const index = rowIds.indexOf(highlightId);
  const scrolledFor = useRef<number>();

  useEffect(() => {
    if (index < 0 || scrolledFor.current === highlightId) return;
    scrolledFor.current = highlightId;
    document.querySelector(`[data-row-key="${highlightId}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightId, index]);

  return {
    highlightId,
    defaultPage: index < 0 ? 1 : Math.floor(index / pageSize) + 1,
    rowProps: (id: number) => (id === highlightId ? { "aria-current": true, className: HIGHLIGHTED_ROW_CLASS } : {}),
  };
}
