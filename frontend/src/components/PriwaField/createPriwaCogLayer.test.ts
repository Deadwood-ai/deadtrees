import { describe, expect, it } from "vitest";

import { resolvePriwaCogUrl } from "./createPriwaCogLayer";

describe("resolvePriwaCogUrl", () => {
  it("keeps absolute COG URLs unchanged", () => {
    expect(resolvePriwaCogUrl("https://example.com/flight.tif")).toBe(
      "https://example.com/flight.tif",
    );
  });

  it("resolves storage-relative COG paths through the configured COG base URL", () => {
    expect(resolvePriwaCogUrl("priwa/project-1/flight.tif")).toContain(
      "/cogs/v1/priwa/project-1/flight.tif",
    );
  });
});
