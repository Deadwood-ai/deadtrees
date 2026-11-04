// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { useHighlightedRow } from "./useHighlightedRow";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const at = (url: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  };

const ids = Array.from({ length: 120 }, (_, index) => 1000 - index);

describe("useHighlightedRow", () => {
  it("names the page holding the row and scrolls to it once", () => {
    const row = document.createElement("tr");
    row.setAttribute("data-row-key", "895");
    row.scrollIntoView = vi.fn();
    document.body.append(row);

    const { result, rerender } = renderHook(() => useHighlightedRow(ids, 50), { wrapper: at("/profile?highlight=895") });

    expect(result.current.defaultPage).toBe(3);
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
    rerender();
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("marks only the linked row", () => {
    const { result } = renderHook(() => useHighlightedRow(ids, 50), { wrapper: at("/profile?highlight=895") });
    expect(result.current.rowProps(895)).toMatchObject({ "aria-current": true });
    expect(result.current.rowProps(896)).toEqual({});
  });

  it.each(["/profile", "/profile?highlight=abc", "/profile?highlight=-3", "/profile?highlight=5"])(
    "stays on the first page and marks nothing for %s",
    (url) => {
      const { result } = renderHook(() => useHighlightedRow(ids, 50), { wrapper: at(url) });
      expect(result.current.defaultPage).toBe(1);
      expect(ids.some((id) => "aria-current" in result.current.rowProps(id))).toBe(false);
    },
  );
});
