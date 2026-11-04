import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/** Cell backgrounds, because Ant Design paints its fixed columns on the cell rather than the row. */
export const HIGHLIGHTED_ROW_CLASS = "[&>td]:!bg-emerald-50";

/**
 * The dataset row named by `?highlight=` in a list: controlled table page plus one
 * scroll into view. It acts once per link, so later paging and refreshes stay with the user.
 */
export function useHighlightedRow(rowIds: number[], pageSize: number) {
  const [params] = useSearchParams();
  const value = Number(params.get("highlight"));
  const highlightId = Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const index = highlightId ? rowIds.indexOf(highlightId) : -1;
  const [page, setPage] = useState(1);
  const shownFor = useRef<number>();

  useEffect(() => {
    if (index < 0 || shownFor.current === highlightId) return;
    const rowPage = Math.floor(index / pageSize) + 1;
    if (page !== rowPage) {
      setPage(rowPage);
      return;
    }
    shownFor.current = highlightId;
    document.querySelector(`[data-row-key="${highlightId}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightId, index, page, pageSize]);

  return { highlightId, page, setPage };
}
