import { describe, expect, it } from "vitest";
import { deadwoodPhenologyWarning, phenologyProbabilityAt } from "./phenologyUtils";

// day n of the year has the value n - 1, so the picked day can be read off the result
const curve = Array.from({ length: 365 }, (_, i) => Math.min(i, 255));

describe("phenologyProbabilityAt", () => {
  it("reads the exact day of a full date", () => {
    // 10 February is day 41
    expect(phenologyProbabilityAt(curve, 2023, 2, 10)).toBeCloseTo(40 / 255);
  });

  it("reads the middle of the month without a day, and the middle of the year with only a year", () => {
    // February 2023: days 32 to 59, the middle is day (64 + 28 - 1) / 2 = 45
    expect(phenologyProbabilityAt(curve, "2023", "2", null)).toBeCloseTo(44 / 255);
    expect(phenologyProbabilityAt(curve, 2023)).toBeCloseTo(182 / 255);
  });

  it("is null without a curve or a year", () => {
    expect(phenologyProbabilityAt(null, 2023, 2, 10)).toBeNull();
    expect(phenologyProbabilityAt(curve, null, 2, 10)).toBeNull();
  });
});

describe("deadwoodPhenologyWarning", () => {
  it("explains a hidden deadwood layer below 50% and says nothing from 50% or without data", () => {
    expect(deadwoodPhenologyWarning(0.31)).toContain("within the maximum greenness period is 31%");
    expect(deadwoodPhenologyWarning(0.5)).toBeNull();
    expect(deadwoodPhenologyWarning(null)).toBeNull();
  });
});
