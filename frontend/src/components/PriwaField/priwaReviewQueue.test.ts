import { describe, expect, it } from "vitest";

import type { IPriwaReviewItem } from "./priwaReviewWorkspace";
import {
  filterPriwaReviewItems,
  filterForPriwaReviewItem,
  findPriwaReviewItemByGroup,
  findPriwaReviewItemByMosaic,
  findPriwaReviewItemByPoint,
  resolvePriwaReviewItemToActivate,
  resolvePriwaReviewSelection,
  resolvePriwaFilteredReviewSelection,
  shouldClosePriwaReviewTree,
} from "./priwaReviewQueue";

const openGroup = {
  kind: "suggested-group",
  key: "suggested:tree-1",
  name: "Vorschlag",
  treeIds: ["tree-1"],
  assignedDatasetIds: [],
  suggestedDatasetIds: ["flight-1"],
  status: "flight_suggested",
  group: null,
  draft: {
    name: "Vorschlag",
    origin: "suggestion",
    treeIds: ["tree-1"],
    datasetIds: ["flight-1"],
  },
  suggestionReason: "Nähe und Datum passen.",
  confidenceLabel: "hoch",
} as IPriwaReviewItem;

const completeGroup = {
  kind: "saved-group",
  key: "group:group-1",
  name: "Gruppe 1",
  treeIds: ["tree-2"],
  assignedDatasetIds: ["flight-2"],
  suggestedDatasetIds: [],
  status: "complete",
  group: {
    id: "group-1",
    projectId: "project-1",
    name: "Gruppe 1",
    origin: "manual",
    confidence: null,
    suggestionReason: null,
    algorithmVersion: null,
    treeIds: ["tree-2"],
    datasetIds: ["flight-2"],
    createdAt: "2026-08-03T00:00:00Z",
    updatedAt: "2026-08-03T00:00:00Z",
  },
  draft: {
    id: "group-1",
    name: "Gruppe 1",
    origin: "manual",
    treeIds: ["tree-2"],
    datasetIds: ["flight-2"],
  },
  suggestionReason: null,
  confidenceLabel: null,
} as IPriwaReviewItem;

const upload = {
  kind: "unassigned-upload",
  key: "upload:flight-3",
  status: "unassigned_upload",
  mosaic: { id: "flight-3", label: "Flug 3" },
  reason: "Keine passende Gruppe gefunden.",
} as IPriwaReviewItem;

const items = [completeGroup, openGroup, upload];

describe("PRIWA review queue", () => {
  it("keeps a valid selection and otherwise advances to the first open task", () => {
    expect(resolvePriwaReviewSelection(items, completeGroup.key)).toBe(
      completeGroup,
    );
    expect(resolvePriwaReviewSelection(items, "removed")).toBe(openGroup);
    expect(resolvePriwaReviewSelection([], null)).toBeNull();
  });

  it("rehydrates a persisted selection exactly once", () => {
    expect(
      resolvePriwaReviewItemToActivate(items, completeGroup.key, null),
    ).toBe(completeGroup);
    expect(
      resolvePriwaReviewItemToActivate(
        items,
        completeGroup.key,
        completeGroup.key,
      ),
    ).toBeNull();
    expect(resolvePriwaReviewItemToActivate(items, "removed", null)).toBeNull();
  });

  it("filters the queue without changing its source order", () => {
    expect(filterPriwaReviewItems(items, "open")).toEqual([openGroup, upload]);
    expect(filterPriwaReviewItems(items, "complete")).toEqual([completeGroup]);
    expect(filterPriwaReviewItems(items, "uploads")).toEqual([upload]);
  });

  it("selects the queue filter that can show an externally selected item", () => {
    expect(filterForPriwaReviewItem(openGroup)).toBe("open");
    expect(filterForPriwaReviewItem(completeGroup)).toBe("complete");
    expect(filterForPriwaReviewItem(upload)).toBe("uploads");
  });

  it("lets a completed map selection escape the active open filter", () => {
    expect(
      resolvePriwaFilteredReviewSelection(
        items,
        "open",
        completeGroup.key,
        true,
      ),
    ).toBe(completeGroup);
    expect(
      resolvePriwaFilteredReviewSelection(
        items,
        "open",
        completeGroup.key,
        false,
      ),
    ).toBe(openGroup);
  });

  it("maps map features back to their canonical review item", () => {
    expect(findPriwaReviewItemByMosaic(items, "flight-1")).toBe(openGroup);
    expect(findPriwaReviewItemByMosaic(items, "flight-2")).toBe(completeGroup);
    expect(findPriwaReviewItemByGroup(items, "group-1")).toBe(completeGroup);
    expect(findPriwaReviewItemByPoint(items, "tree-1")).toBe(openGroup);
  });

  it("moves an open tree editor out of the embedded panel when the queue advances", () => {
    expect(shouldClosePriwaReviewTree(openGroup, "tree-1")).toBe(false);
    expect(shouldClosePriwaReviewTree(completeGroup, "tree-1")).toBe(true);
    expect(shouldClosePriwaReviewTree(upload, "tree-1")).toBe(true);
  });
});
