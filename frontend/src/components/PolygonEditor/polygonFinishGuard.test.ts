import { describe, expect, it } from "vitest";

import { CLOSE_TOLERANCE_PX, DOUBLE_CLICK_MS, shouldFinishPolygon } from "./polygonFinishGuard";

describe("shouldFinishPolygon", () => {
  const firstVertex: [number, number] = [100, 100];

  it("does not finish on a slow click near the previous vertex", () => {
    expect(shouldFinishPolygon([300, 300], firstVertex, 900)).toBe(false);
  });

  it("finishes on a click on the first vertex", () => {
    expect(shouldFinishPolygon([100 + CLOSE_TOLERANCE_PX, 100], firstVertex, 900)).toBe(true);
  });

  it("does not finish just outside the first vertex", () => {
    expect(shouldFinishPolygon([100 + CLOSE_TOLERANCE_PX, 101], firstVertex, 900)).toBe(false);
  });

  it("finishes on the second click of a double-click", () => {
    expect(shouldFinishPolygon([300, 300], firstVertex, DOUBLE_CLICK_MS - 1)).toBe(true);
  });

  it("does not take a click after the double-click window as a double-click", () => {
    expect(shouldFinishPolygon([300, 300], firstVertex, DOUBLE_CLICK_MS)).toBe(false);
  });

  it("does not finish without a sketch to measure against", () => {
    expect(shouldFinishPolygon([100, 100], null, 900)).toBe(false);
  });
});
