import { describe, expect, it } from "vitest";
import type { WaybackItemWithMetadata } from "../../hooks/useWaybackItems";
import { findClosestImagery } from "./YearImagerySelector";

const item = (
  releaseNum: number,
  releaseDateLabel: string,
  acquisitionDate?: string,
): WaybackItemWithMetadata => ({
  itemID: `item-${releaseNum}`,
  itemTitle: `World Imagery (Wayback ${releaseDateLabel})`,
  itemURL: `https://example.com/${releaseNum}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.example.com/${releaseNum}`,
  metadataLayerItemID: `metadata-${releaseNum}`,
  layerIdentifier: `WB_${releaseNum}`,
  releaseNum,
  releaseDateLabel,
  releaseDatetime: new Date(releaseDateLabel).getTime(),
  acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : undefined,
});

describe("findClosestImagery", () => {
  it("uses release dates when metadata acquisition dates are unavailable", () => {
    const closest = findClosestImagery(
      [
        item(100, "1999-01-15", "1999-01-15"),
        item(200, "2022-10-04"),
        item(300, "2024-08-20"),
      ],
      2025,
    );

    expect(closest?.releaseNum).toBe(300);
  });
});
