import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  registerWaybackReleaseDate,
  type WaybackItemWithMetadata,
} from "../../hooks/useWaybackItems";
import {
  findClosestImagery,
  getVerifiedImageryYears,
  pickAutoMatchImagery,
} from "./YearImagerySelector";
import YearImagerySelector from "./YearImagerySelector";

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

describe("getVerifiedImageryYears", () => {
  it("only counts verified acquisition dates, never release-date fallbacks", () => {
    const years = getVerifiedImageryYears([
      item(100, "2021-01-06", "2019-06-15"), // released 2021, captured 2019
      item(200, "2022-10-04"), // metadata not resolved yet
      item(300, "2023-05-11", "2023-05-11"),
    ]);

    // 2019 and 2023 are verified; the unresolved item must not produce a
    // (release-date) 2022 dot that would later jump to another year.
    expect([...years].sort()).toEqual(["2019", "2023"]);
  });
});

describe("pickAutoMatchImagery", () => {
  // ESRI release numbers are NOT ordered by time — mirror that here.
  const items = [
    item(48376, "2019-05-01", "2019-05-01"),
    item(7110, "2022-07-28", "2022-07-28"),
    item(57965, "2023-05-28", "2023-05-28"),
  ];

  it("switches to the closest item for the target year", () => {
    expect(pickAutoMatchImagery(items, 2022, 57965)).toBe(7110);
  });

  it("keeps the selection when it is already the closest item", () => {
    expect(pickAutoMatchImagery(items, 2022, 7110)).toBeNull();
  });

  it("keeps the selection when its imagery year already matches the candidate's", () => {
    // Two releases with 2022 imagery; the picker's closest match is the later
    // one, but the selected release is also from 2022 — switching would
    // reload the basemap without changing the displayed year.
    const sameYear = [...items, item(250, "2022-11-02", "2022-11-02")];
    expect(pickAutoMatchImagery(sameYear, 2022, 7110)).toBeNull();
  });

  it("switches when the selection cannot be resolved to a candidate", () => {
    // Unknown release date: assume the closest candidate is an improvement.
    expect(pickAutoMatchImagery(items, 2022, 424243)).toBe(7110);
  });

  it("keeps a selection that already shows the closest candidate's imagery", () => {
    // A release published between the 2022 and 2023 changes serves the 2022
    // change's tiles, so switching to it would reload the same image.
    registerWaybackReleaseDate(90001, new Date("2022-11-02").getTime());
    expect(pickAutoMatchImagery(items, 2022, 90001)).toBeNull();
  });

  it("keeps a newer-than-newest selection when the newest candidate matches", () => {
    // The default (newest) release shows the newest candidate's imagery.
    registerWaybackReleaseDate(90002, new Date("2026-06-30").getTime());
    expect(pickAutoMatchImagery(items, 2023, 90002)).toBeNull();
  });
});

describe("manual imagery history", () => {
  it("offers an explicit load action before local candidates exist", () => {
    const markup = renderToStaticMarkup(
      createElement(YearImagerySelector, {
        predictionYear: "2025",
        onPredictionYearChange: () => undefined,
        selectedReleaseNum: 32246,
        onImageryChange: () => undefined,
        waybackItems: [],
        isLoading: false,
        isWaybackActive: true,
        onRequestLocalImagery: () => undefined,
      }),
    );

    expect(markup).toContain("Browse imagery history");
  });
});
