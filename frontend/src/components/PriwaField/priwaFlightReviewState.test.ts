import { describe, expect, it } from "vitest";

import { reconcilePriwaMosaicVisibility } from "./priwaFlightReviewState";

describe("PRIWA flight-review visibility state", () => {
  it("enables newly matched flights without re-enabling a known hidden flight", () => {
    expect(
      reconcilePriwaMosaicVisibility(
        new Set(["visible-known"]),
        new Set(["visible-known", "hidden-known"]),
        ["visible-known", "hidden-known", "new-match"],
        new Set(["visible-known", "hidden-known", "new-match"]),
      ),
    ).toEqual(new Set(["visible-known", "new-match"]));
  });

  it("removes flights that no longer belong to the review catalog", () => {
    expect(
      reconcilePriwaMosaicVisibility(
        new Set(["removed", "remaining"]),
        new Set(["removed", "remaining"]),
        ["remaining"],
        new Set(),
      ),
    ).toEqual(new Set(["remaining"]));
  });
});
