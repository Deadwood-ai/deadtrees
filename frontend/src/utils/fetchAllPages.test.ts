import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "./fetchAllPages";

describe("fetchAllPages", () => {
  it("keeps reading until a page comes back short", async () => {
    const all = Array.from({ length: 2345 }, (_, i) => i);
    const fetchPage = vi.fn(async (from: number, to: number) => all.slice(from, to + 1));
    expect(await fetchAllPages(fetchPage, 1000)).toEqual(all);
    expect(fetchPage.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("asks once more after an exactly full last page", async () => {
    const fetchPage = vi.fn(async (from: number) => (from === 0 ? [1, 2] : []));
    expect(await fetchAllPages(fetchPage, 2)).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
