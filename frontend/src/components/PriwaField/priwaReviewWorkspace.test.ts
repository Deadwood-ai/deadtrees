import { describe, expect, it } from "vitest";

import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";
import {
  buildPriwaReviewWorkspace,
  reconcilePriwaDatasetAssignments,
  reviewItemDatasetIds,
  setPriwaDatasetAssignment,
} from "./priwaReviewWorkspace";

const point = (id: string, lon: number, date = "2026-06-12"): IPriwaPoint => ({
  id,
  lat: 48.455,
  lon,
  baumnr: id,
  fund: "ja",
  baumart: "Fichte",
  bm: "nein",
  bohrloch: "nein",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: date,
  kom: "",
  capturedAt: `${date}T10:00:00Z`,
  coordinateSource: "qr",
  gps: "ja",
});

describe("setPriwaDatasetAssignment", () => {
  it("adds an assignment once without replacing adjacent flights", () => {
    expect(setPriwaDatasetAssignment(["flight-1"], "flight-2", true)).toEqual([
      "flight-1",
      "flight-2",
    ]);
    expect(
      setPriwaDatasetAssignment(["flight-1", "flight-2"], "flight-2", true),
    ).toEqual(["flight-1", "flight-2"]);
  });

  it("removes only the selected assignment", () => {
    expect(
      setPriwaDatasetAssignment(
        ["flight-1", "flight-2", "flight-3"],
        "flight-2",
        false,
      ),
    ).toEqual(["flight-1", "flight-3"]);
  });
});

describe("reconcilePriwaDatasetAssignments", () => {
  it("drops a classified flight after a workspace rerender", () => {
    expect(
      reconcilePriwaDatasetAssignments(
        ["flight-1", "flight-2"],
        ["flight-1"],
      ),
    ).toEqual(["flight-1"]);
  });

  it("does not reselect flights the reviewer explicitly deselected", () => {
    expect(
      reconcilePriwaDatasetAssignments(
        ["flight-1"],
        ["flight-1", "flight-2"],
      ),
    ).toEqual(["flight-1"]);
  });
});

const mosaic = (
  id: string,
  flightType: IPriwaMosaic["flightType"] = null,
): IPriwaMosaic => ({
  id,
  projectId: "project-1",
  label: `Flug ${id}`,
  cogUrl: `https://example.test/${id}.tif`,
  bbox: "BOX(8.149 48.454,8.151 48.456)",
  captureDate: "2026-06-14",
  createdAt: "2026-06-15T10:00:00Z",
  authors: [],
  additionalInformation: null,
  flightType,
});

const group = (
  treeIds: string[],
  datasetIds: string[] = [],
): IPriwaBefallsgruppe => ({
  id: "group-1",
  projectId: "project-1",
  name: "Befallsgruppe Nord",
  origin: "suggestion",
  confidence: 0.9,
  suggestionReason: "Nähe und Datum passen.",
  algorithmVersion: "v1",
  treeIds,
  datasetIds,
  createdAt: "2026-06-15",
  updatedAt: "2026-06-15",
});

describe("buildPriwaReviewWorkspace", () => {
  it("keeps a saved group as the work item and suggests its nearby flight", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15), point("2", 8.1501)],
      [mosaic("flight-1")],
      [group(["1", "2"])],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "group:group-1",
      kind: "saved-group",
      status: "flight_suggested",
      suggestedDatasetIds: ["flight-1"],
    });
  });

  it("suggests every overlapping flight inside the date window", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15)],
      [
        { ...mosaic("flight-near"), captureDate: "2026-06-13" },
        { ...mosaic("flight-far"), captureDate: "2026-06-17" },
      ],
      [group(["1"])],
    );

    expect(items[0]).toMatchObject({
      key: "group:group-1",
      suggestedDatasetIds: ["flight-near", "flight-far"],
    });
  });

  it("marks a confirmed reviewed group complete", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15)],
      [mosaic("flight-1", "umfeldbefliegung")],
      [group(["1"], ["flight-1"])],
    );

    expect(items[0]).toMatchObject({ status: "complete" });
  });

  it("keeps a confirmed group open when another flight is suggested", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15)],
      [
        mosaic("flight-1", "umfeldbefliegung"),
        { ...mosaic("flight-2"), captureDate: "2026-06-13" },
      ],
      [group(["1"], ["flight-1"])],
    );

    expect(items[0]).toMatchObject({
      status: "flight_suggested",
      suggestedDatasetIds: ["flight-2"],
    });
    expect(reviewItemDatasetIds(items[0])).toEqual(["flight-1", "flight-2"]);
  });

  it("creates a suggested group rather than separate tree work items", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15), point("2", 8.1501)],
      [mosaic("flight-1")],
      [],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "suggested-group",
      status: "group_suggestion",
      treeIds: ["1", "2"],
      suggestedDatasetIds: ["flight-1"],
    });
  });

  it("keeps genuinely unmatched uploads in the same review queue", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.17)],
      [mosaic("flight-1")],
      [],
    );

    expect(items).toEqual([
      expect.objectContaining({
        key: "upload:flight-1",
        kind: "unassigned-upload",
        status: "unassigned_upload",
      }),
    ]);
  });

  it("keeps a matched flight visible when its single tree forms no group", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.15)],
      [mosaic("flight-1")],
      [],
    );

    expect(items).toEqual([
      expect.objectContaining({
        key: "upload:flight-1",
        status: "unassigned_upload",
        reason: expect.stringContaining("einzelnen Käferbäumen"),
      }),
    ]);
  });

  it("keeps excluded uploads available as reversible completed work", () => {
    const items = buildPriwaReviewWorkspace(
      [point("1", 8.17)],
      [mosaic("flight-1", "not_priwa")],
      [],
    );

    expect(items).toEqual([
      expect.objectContaining({
        key: "upload:flight-1",
        kind: "unassigned-upload",
        status: "excluded_upload",
      }),
    ]);
  });
});
