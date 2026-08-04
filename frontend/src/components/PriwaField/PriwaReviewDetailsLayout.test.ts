import { describe, expect, it } from "vitest";

import { getPriwaReviewDetailsLayoutState } from "./PriwaReviewDetailsLayout";

describe("PRIWA review details layout", () => {
  it("replaces the detail panel with the tree on narrower desktops", () => {
    expect(getPriwaReviewDetailsLayoutState(false, true)).toEqual({
      showGroup: false,
      treePlacement: "detail",
    });
  });

  it("shows tree and group beside each other above the desktop breakpoint", () => {
    expect(getPriwaReviewDetailsLayoutState(true, true)).toEqual({
      showGroup: true,
      treePlacement: "adjacent",
    });
  });

  it("keeps the group panel when no tree is selected", () => {
    expect(getPriwaReviewDetailsLayoutState(false, false)).toEqual({
      showGroup: true,
      treePlacement: null,
    });
  });
});
