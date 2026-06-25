import { describe, expect, it } from "vitest";

import {
  createPriwaCogLayers,
  resolvePriwaCogUrl,
} from "./createPriwaCogLayer";

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

  it("creates one map layer per PRIWA mosaic", () => {
    expect(
      createPriwaCogLayers([
        { cogUrl: "priwa/project-1/flight-a.tif" },
        { cogUrl: "priwa/project-1/flight-b.tif" },
      ]),
    ).toHaveLength(2);
  });
});
