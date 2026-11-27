import { describe, expect, it, vi } from "vitest";
import { allRows } from "./allRows";

const answer = <T>(data: T[]) => Promise.resolve({ data, error: null });

describe("allRows", () => {
  it("keeps reading until a page comes back short", async () => {
    const all = Array.from({ length: 2345 }, (_, i) => i);
    const page = vi.fn((from: number, to: number) => answer(all.slice(from, to + 1)));
    expect(await allRows(page)).toEqual(all);
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("asks once more after an exactly full last page", async () => {
    const all = Array.from({ length: 1000 }, (_, i) => i);
    const page = vi.fn((from: number, to: number) => answer(all.slice(from, to + 1)));
    expect(await allRows(page)).toEqual(all);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("throws the API's error", async () => {
    const error = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(allRows(() => Promise.resolve({ data: null, error }))).rejects.toBe(error);
  });
});
