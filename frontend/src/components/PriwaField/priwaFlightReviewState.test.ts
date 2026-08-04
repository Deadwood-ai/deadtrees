import { describe, expect, it } from "vitest";

import { reconcilePriwaMosaicVisibility } from "./priwaFlightReviewState";

describe("PRIWA flight-review visibility state", () => {
  it("keeps visibility explicit when new matched flights arrive", () => {
    expect(
      reconcilePriwaMosaicVisibility(
        new Set(["visible-known"]),
        ["visible-known", "hidden-known", "new-match"],
      ),
    ).toEqual(new Set(["visible-known"]));
  });

  it("does not load every matched flight before a review item is selected", () => {
    expect(
      reconcilePriwaMosaicVisibility(
        new Set(),
        ["match-one", "match-two", "match-three"],
      ),
    ).toEqual(new Set());
  });

  it("removes flights that no longer belong to the review catalog", () => {
    expect(
      reconcilePriwaMosaicVisibility(
        new Set(["removed", "remaining"]),
        ["remaining"],
      ),
    ).toEqual(new Set(["remaining"]));
  });
});
