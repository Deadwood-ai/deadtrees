import { describe, expect, it } from "vitest";
import {
  canOpenOwnerMap,
  imageCheck,
  needsAttention,
  processingStatus,
  statusSummary,
  type ContributorDataset,
  type QueueState,
} from "./status";

const complete: ContributorDataset = {
  id: 12,
  file_name: "survey.tif",
  current_status: "idle",
  is_upload_done: true,
  is_ortho_done: true,
  is_metadata_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
  cog_path: "12/ortho.tif",
  audit_decision: "keep",
};
const emptyQueue: QueueState = { state: "loaded" };

describe("processing outcome", () => {
  it("labels a failure after a usable map as stopped, not failed", () => {
    const state = processingStatus(
      { ...complete, has_error: true, error_stage: "deadwood_treecover_combined_v2" },
      emptyQueue,
    );
    expect(state.label).toBe("Stopped · map available");
    expect(state.color).toBe("warning");
    expect(state.detail).toContain("stopped during combined AI analysis");
    expect(state.detail).not.toContain("No map image");
  });

  it("labels a failure without a map as failed and says no map exists", () => {
    const state = processingStatus(
      { ...complete, has_error: true, error_stage: "cog_processing", cog_path: null, is_cog_done: false },
      emptyQueue,
    );
    expect(state.label).toBe("Processing failed");
    expect(state.color).toBe("error");
    expect(state.detail).toContain("map image preparation");
    expect(state.detail).toContain("No map image is available");
  });

  it("never echoes an unrecognized stage identifier into user copy", () => {
    const state = processingStatus({ ...complete, has_error: true, error_stage: "internal_step_x" }, emptyQueue);
    expect(state.detail).not.toContain("internal_step_x");
    expect(state.detail).toContain("cannot describe");
  });

  it("does not infer a failed stage from incomplete flags", () => {
    const state = processingStatus({ ...complete, has_error: true, is_thumbnail_done: false }, emptyQueue);
    expect(state.detail).toContain("not recorded");
  });

  it("recognizes a queued rerun even when previous outputs are complete", () => {
    expect(
      processingStatus(complete, {
        state: "loaded",
        item: { dataset_id: 12, current_position: 4, estimated_time: null, task_types: ["cog_processing"] },
      }).label,
    ).toBe("Queued");
  });

  it.each(["loading", "error"] as const)("does not treat %s queue data as an empty queue", (state) => {
    expect(processingStatus(complete, { state }).label).not.toBe("Results ready");
    expect(processingStatus(complete, { state }).kind).toBe(state === "loading" ? "checking" : "unavailable");
  });

  it("does not declare readiness when thumbnail or required AOI is missing", () => {
    expect(processingStatus({ ...complete, is_thumbnail_done: false }, emptyQueue).label).toBe(
      "Incomplete · map available",
    );
    expect(
      processingStatus({ ...complete, is_aoi_required: true, is_aoi_done: false, cog_path: null }, emptyQueue).label,
    ).toBe("Incomplete");
  });

  it("preserves legacy readiness but respects active final stages", () => {
    expect(processingStatus(complete, emptyQueue).label).toBe("Results ready");
    const running = processingStatus({ ...complete, current_status: "embedding_processing" }, emptyQueue);
    expect(running.label).toBe("Processing");
    expect(running.detail).toContain("search indexing");
  });

  it("keeps completed processing while a review lock is active", () => {
    expect(processingStatus({ ...complete, current_status: "audit_in_progress" }, emptyQueue).label).toBe(
      "Results ready",
    );
  });
});

describe("map image", () => {
  it("opens the map only when the map image exists", () => {
    expect(canOpenOwnerMap(complete)).toBe(true);
    expect(canOpenOwnerMap({ ...complete, cog_path: null })).toBe(false);
    expect(canOpenOwnerMap({ ...complete, is_cog_done: false })).toBe(false);
  });
});

describe("image check", () => {
  it("reads the dataset evaluation's decision", () => {
    expect(imageCheck(complete)?.label).toBe("Image accepted");
    expect(imageCheck({ ...complete, audit_decision: "exclude" })?.label).toBe("Excluded from public map");
    expect(imageCheck({ ...complete, audit_decision: null })?.kind).toBe("pending");
  });

  it("separates exclusion from completed processing", () => {
    expect(processingStatus({ ...complete, audit_decision: "exclude" }, emptyQueue).label).toBe("Results ready");
  });

  it("says nothing about a check that cannot run without a map image", () => {
    expect(imageCheck({ ...complete, audit_decision: null, cog_path: null })).toBeNull();
  });
});

describe("attention and summary", () => {
  it("asks for attention only where the details change what the contributor should rely on", () => {
    const check = imageCheck(complete);
    expect(needsAttention(processingStatus(complete, emptyQueue), check)).toBe(false);
    expect(needsAttention(processingStatus({ ...complete, has_error: true }, emptyQueue), check)).toBe(true);
    expect(needsAttention(processingStatus(complete, { state: "loading" }), check)).toBe(false);
    expect(
      needsAttention(processingStatus(complete, emptyQueue), imageCheck({ ...complete, audit_decision: "exclude" })),
    ).toBe(true);
  });

  it("never promises a retry or a follow-up", () => {
    const summary = statusSummary(
      { ...complete, has_error: true, error_stage: "deadwood_treecover_combined_v2" },
      emptyQueue,
    );
    expect(summary.headline).toContain("stopped during combined AI analysis");
    expect(summary.next).toContain("include dataset 12");
    for (const banned of ["retry", "working on it", "will follow up", "No action"]) {
      expect(`${summary.headline} ${summary.next}`.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("does not expect anything from the contributor while processing runs or waits", () => {
    expect(statusSummary({ ...complete, current_status: "cog_processing" }, emptyQueue).next).toBe(
      "Nothing to do while it runs.",
    );
    expect(
      statusSummary(complete, {
        state: "loaded",
        item: { dataset_id: 12, current_position: 2, estimated_time: null, task_types: null },
      }).next,
    ).toBe("Nothing to do while it waits.");
    expect(statusSummary(complete, emptyQueue).next).toBeNull();
  });

  it("explains exclusion without naming who can fix it", () => {
    const summary = statusSummary({ ...complete, audit_decision: "exclude" }, emptyQueue);
    expect(summary.headline).toContain("did not pass the quality check, so it is not on the public map");
    expect(summary.headline).toContain("It stays in your account.");
    expect(summary.next).toBeNull();
  });
});
