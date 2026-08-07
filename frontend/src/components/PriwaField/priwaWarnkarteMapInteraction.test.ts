import { describe, expect, it } from "vitest";

import { formatPriwaWarnkarteProbability } from "./priwaWarnkarteMapInteraction";

describe("Warnkarte polygon interaction", () => {
  it("formats normalized probabilities for the map tooltip", () => {
    expect(formatPriwaWarnkarteProbability(0.6)).toBe(
      "Wahrscheinlichkeit: 60 %",
    );
    expect(formatPriwaWarnkarteProbability("1.0")).toBe(
      "Wahrscheinlichkeit: 100 %",
    );
  });
});
