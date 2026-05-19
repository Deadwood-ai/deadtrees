import { describe, expect, it } from "vitest";

import {
  getShortestHeadingDelta,
  normalizeHeading,
  shouldUseGpsHeading,
  smoothHeading,
} from "./headingStabilizer";

describe("heading stabilizer", () => {
  it("normalizes headings into the compass circle", () => {
    expect(normalizeHeading(370)).toBe(10);
    expect(normalizeHeading(-10)).toBe(350);
    expect(normalizeHeading(720)).toBe(0);
  });

  it("uses the shortest turn across the north boundary", () => {
    expect(getShortestHeadingDelta(350, 10)).toBe(20);
    expect(getShortestHeadingDelta(10, 350)).toBe(-20);
  });

  it("smooths headings without jumping through the long arc", () => {
    expect(smoothHeading(350, 10, 0.5)).toBe(0);
    expect(smoothHeading(10, 350, 0.5)).toBe(0);
  });

  it("starts from the first valid heading directly", () => {
    expect(smoothHeading(null, 370, 0.25)).toBe(10);
  });

  it("only trusts GPS heading while moving", () => {
    expect(shouldUseGpsHeading(45, 0)).toBe(false);
    expect(shouldUseGpsHeading(45, 1.24)).toBe(false);
    expect(shouldUseGpsHeading(45, 1.25)).toBe(true);
    expect(shouldUseGpsHeading(null, 2)).toBe(false);
  });
});
