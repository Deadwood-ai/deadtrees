import { describe, expect, it } from "vitest";
import { AUDIT_SECTIONS, evaluationAnswerText, judgeName, judgementText, stepCrop } from "./auditChecks";

const NO_ISSUES = { cog_issue: false, thumbnail_issue: false };

describe("the dataset evaluation in words", () => {
  it("says what a person decided", () => {
    expect(evaluationAnswerText({ decision: "keep", exclude_reason: null, ...NO_ISSUES })).toBe("OK");
    expect(evaluationAnswerText({ decision: "keep", exclude_reason: null, cog_issue: true, thumbnail_issue: true })).toBe("OK (COG issue, thumbnail issue)");
    expect(evaluationAnswerText({ decision: "exclude", exclude_reason: "blurry", ...NO_ISSUES })).toBe("Exclude (blurry)");
    expect(evaluationAnswerText({ decision: "exclude", exclude_reason: null, ...NO_ISSUES })).toBe("Exclude");
  });

  it("says what a model answered", () => {
    expect(judgementText({ verdict: "major", exclude_reason: "no_trees", ...NO_ISSUES })).toBe("Major (no trees)");
    expect(judgementText({ verdict: "ok", exclude_reason: null, cog_issue: true, thumbnail_issue: false })).toBe("OK (COG issue)");
    expect(judgementText({ verdict: "not_assessable", exclude_reason: null, ...NO_ISSUES })).toBe("Can't tell");
  });
});

describe("a judge's name", () => {
  it("is short", () => {
    expect(judgeName("luna-medium")).toBe("Luna");
    expect(judgeName("haiku-5.5")).toBe("Haiku");
  });
});

describe("tiles", () => {
  it("steps through the tiles and wraps around", () => {
    const tiles = [{ id: 2 }, { id: 9 }, { id: 5 }];
    expect(stepCrop(tiles, null, 1)).toBe(2);
    expect(stepCrop(tiles, null, -1)).toBe(5);
    expect(stepCrop(tiles, 9, 1)).toBe(5);
    expect(stepCrop(tiles, 5, 1)).toBe(2);
    expect(stepCrop(tiles, 2, -1)).toBe(5);
    expect(stepCrop([], null, 1)).toBeNull();
  });
});

describe("section definitions", () => {
  it("goes through the seven steps in order, each review item answered by its own step", () => {
    expect(AUDIT_SECTIONS.map((s) => s.id)).toEqual(["evaluation", "aoi", "georef", "date", "phenology", "forest", "deadwood"]);
    expect(AUDIT_SECTIONS.map((s) => s.reviewItem).filter(Boolean)).toEqual(["evaluation", "aoi", "georef", "date"]);
    expect(AUDIT_SECTIONS.filter((s) => s.layer).map((s) => s.layer)).toEqual(["forest_cover", "deadwood"]);
  });
});
