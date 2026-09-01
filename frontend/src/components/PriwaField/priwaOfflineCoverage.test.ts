import { describe, expect, it } from "vitest";

import { calculatePriwaOfflineCoverageRatio } from "./priwaOfflineCoverage";

describe("PRIWA offline viewport coverage", () => {
  it("returns the covered share of the current viewport", () => {
    expect(
      calculatePriwaOfflineCoverageRatio([0, 0, 10, 10], [[0, 0, 8, 10]]),
    ).toBe(0.8);
  });

  it("does not count overlapping downloaded areas twice", () => {
    expect(
      calculatePriwaOfflineCoverageRatio(
        [0, 0, 10, 10],
        [
          [0, 0, 6, 10],
          [4, 0, 10, 10],
        ],
      ),
    ).toBe(1);
  });

  it("clips downloaded areas to the viewport", () => {
    expect(
      calculatePriwaOfflineCoverageRatio(
        [0, 0, 10, 10],
        [
          [-10, -10, 5, 5],
          [5, 5, 20, 20],
        ],
      ),
    ).toBe(0.5);
  });

  it("returns zero before the map has a measurable viewport", () => {
    expect(calculatePriwaOfflineCoverageRatio(null, [[0, 0, 10, 10]])).toBe(0);
    expect(calculatePriwaOfflineCoverageRatio([0, 0, 0, 10], [])).toBe(0);
  });
});
