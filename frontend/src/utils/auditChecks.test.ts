import { describe, expect, it } from "vitest";
import type { IAuditAssessment } from "../types/auditChecks";
import {
  AUDIT_SECTIONS,
  evaluationAnswerText,
  evaluationFlags,
  mergeAnswers,
  reviewAnswer,
  orderedCrops,
  runEvidence,
  sectionOfCheck,
  stepCrop,
} from "./auditChecks";

const row = (overrides: Partial<IAuditAssessment>): IAuditAssessment => ({
  id: 1,
  check_key: "georef",
  dataset_id: 7,
  crop_id: null,
  run_id: 10,
  layer: "georef",
  label_id: null,
  assessor_kind: "model",
  assessor_user_id: null,
  model: "romav2",
  prompt_version: "v1",
  assessor: "romav2/v1",
  verdict: "major",
  reason_code: null,
  reason_text: null,
  details: {},
  ...overrides,
});

const person = (userId: string, overrides: Partial<IAuditAssessment> = {}) =>
  row({ assessor_kind: "person", assessor_user_id: userId, assessor: userId, model: null, prompt_version: null, ...overrides });

describe("answers", () => {
  const people = [
    person("me", { verdict: "ok", run_id: 10 }),
    person("clemens", { verdict: "major", run_id: 10 }),
    person("teja", { verdict: "ok", run_id: 10, crop_id: 4, layer: "deadwood" }),
  ];
  const target = { checkKey: "georef" as const, layer: "georef" as const };

  it("takes the review's latest answer on the current run, whoever gave it", () => {
    const later = person("clemens", { id: 2, verdict: "major", run_id: 10 });
    expect(reviewAnswer([...people.slice(0, 1), later], 10, target)?.verdict).toBe("major");
    expect(reviewAnswer(people, 11, target)).toBeNull();
  });

  it("replaces a person's earlier answer on a target", () => {
    const changed = person("me", { id: 9, verdict: "major", run_id: 10 });
    const merged = mergeAnswers(people, [changed]);
    expect(merged).toHaveLength(3);
    expect(reviewAnswer(merged, 10, target)?.id).toBe(9);
    // an answer on another crop is a new target
    expect(mergeAnswers(people, [person("teja", { crop_id: 5, layer: "deadwood" })])).toHaveLength(4);
  });
});

describe("the dataset evaluation answer", () => {
  const answer = (overrides: Partial<IAuditAssessment>) => person("me", { check_key: "dataset_evaluation", layer: "image", run_id: 30, ...overrides });

  it("says what a row decided in a few words", () => {
    expect(evaluationAnswerText(answer({ verdict: "ok" }))).toBe("OK");
    expect(evaluationAnswerText(answer({ verdict: "ok", details: { fix_flags: ["cog_issue", "thumbnail_issue"] } }))).toBe("OK (COG issue, thumbnail issue)");
    // an earlier "keep, fix" is OK
    expect(evaluationAnswerText(answer({ verdict: "minor", details: { fix_flags: ["reprocess"] } }))).toBe("OK (needs reprocessing)");
    expect(evaluationAnswerText(answer({ verdict: "minor" }))).toBe("OK");
    expect(evaluationAnswerText(answer({ verdict: "major", reason_code: "blurry" }))).toBe("Exclude (blurry)");
    // a rule row keeps its reason in the details
    expect(evaluationAnswerText(row({ assessor_kind: "rule", verdict: "major", details: { reason: "no_trees" } }))).toBe("Exclude (no trees)");
    expect(evaluationAnswerText(answer({ verdict: "unsure" }))).toBe("Unsure");
  });

  it("reads the known flags and nothing else", () => {
    expect(evaluationFlags(answer({ details: { fix_flags: ["reprocess", "blurry", "thumbnail_issue"] } }))).toEqual(["thumbnail_issue", "reprocess"]);
    expect(evaluationFlags(answer({ details: { fix_flags: "cog_issue" } }))).toEqual([]);
    expect(evaluationFlags(null)).toEqual([]);
  });
});

describe("crops", () => {
  const crop = (id: number, sets: string[], ortho = "a") => ({
    id,
    ortho_sha256: ortho,
    crop_sets: sets,
    geometry: { type: "Polygon" as const, coordinates: [] },
  });
  const image = (id: number, cropId: number | null, kind: "raw" | "deadwood_overlay" | "overview", labelId: number | null = null, ortho = "a") => ({
    id,
    ortho_sha256: ortho,
    crop_id: cropId,
    label_id: labelId,
    kind,
    storage_path: `audit/${id}.jpg`,
    width: 1024,
    height: 1024,
  });

  it("picks what a run judged from the dataset's rows", () => {
    const run = { id: 20, check_key: "prediction_quality" as const, inputs: { ortho_sha256: "a" }, evidence: {} };
    const judged = runEvidence(run, {
      automated: [
        row({ check_key: "prediction_quality", run_id: 20, crop_id: 1, layer: "deadwood", label_id: 52 }),
        row({ check_key: "georef", run_id: 10 }),
      ],
      // crop 1 is named by a row, crop 2 is in the check's set, crop 3 is another check's, crop 4 another ortho's
      crops: [crop(1, ["benchmark"]), crop(2, ["exclude"]), crop(3, ["evaluation"]), crop(4, ["exclude"], "b")],
      images: [
        image(1, 1, "raw"),
        image(2, 1, "deadwood_overlay", 52),
        // the overlay of an earlier prediction of the same crop
        image(3, 1, "deadwood_overlay", 41),
        image(4, 3, "raw"),
        image(5, null, "overview"),
        image(6, null, "overview", null, "b"),
      ],
    });
    expect(judged.automated).toHaveLength(1);
    expect(judged.crops.map((c) => c.id)).toEqual([1, 2]);
    expect(judged.images.map((i) => i.id)).toEqual([1, 2, 5]);
  });

  it("shows the crops a run names and its own image files", () => {
    // crop 2 is in the check's set from an earlier run on the same ortho; this run judged crop 1 only,
    // and with another AOI: its raw image differs from the stored row
    const own = { crop_ids: [1], images: [{ crop_id: 1, label_id: null, kind: "raw", storage_path: "audit/own-raw.jpg" }] };
    const run = { id: 21, check_key: "prediction_quality" as const, inputs: { ortho_sha256: "a" }, evidence: { judged: own } };
    const judged = runEvidence(run, {
      automated: [row({ check_key: "prediction_quality", run_id: 21, crop_id: 1, layer: "deadwood", label_id: 52 })],
      crops: [crop(1, ["exclude"]), crop(2, ["exclude"])],
      images: [image(1, 1, "raw"), image(2, 1, "deadwood_overlay", 52), image(3, 2, "raw")],
    });
    expect(judged.crops.map((c) => c.id)).toEqual([1]);
    expect(judged.images.map((i) => [i.id, i.storage_path])).toEqual([
      [1, "audit/own-raw.jpg"],
      [2, image(2, 1, "deadwood_overlay", 52).storage_path],
    ]);
  });

  it("shows a dataset evaluation's own overview, which names no crop", () => {
    // an earlier version's overview is the stored row; this run judged another picture of the ortho
    const own = { crop_ids: [1], images: [{ kind: "overview", crop_index: null, storage_path: "audit/own-overview.jpg" }, { kind: "raw", crop_index: 1, storage_path: "audit/own-crop.jpg" }] };
    const run = { id: 22, check_key: "dataset_evaluation" as const, inputs: { ortho_sha256: "a" }, evidence: { judged: own } };
    const judged = runEvidence(run, { automated: [], crops: [crop(1, ["evaluation"])], images: [image(1, 1, "raw"), image(5, null, "overview")] });
    expect(judged.images.map((i) => [i.id, i.storage_path])).toEqual([
      [1, image(1, 1, "raw").storage_path],
      [5, "audit/own-overview.jpg"],
    ]);
  });

  it("numbers the exclude set first", () => {
    const ordered = orderedCrops({ crops: [crop(5, ["training"]), crop(9, ["exclude"]), crop(2, ["training", "exclude"])] });
    expect(ordered.map((c) => c.id)).toEqual([2, 9, 5]);
  });

  it("steps through the crops and wraps around", () => {
    const crops = [{ id: 2 }, { id: 9 }, { id: 5 }];
    expect(stepCrop(crops, null, 1)).toBe(2);
    expect(stepCrop(crops, null, -1)).toBe(5);
    expect(stepCrop(crops, 9, 1)).toBe(5);
    expect(stepCrop(crops, 5, 1)).toBe(2);
    expect(stepCrop(crops, 2, -1)).toBe(5);
    expect(stepCrop([], null, 1)).toBeNull();
  });
});

describe("section definitions", () => {
  it("goes through the seven steps in order, each review item answered by its own step", () => {
    expect(AUDIT_SECTIONS.map((s) => s.id)).toEqual(["evaluation", "aoi", "georef", "date", "phenology", "forest", "deadwood"]);
    expect(AUDIT_SECTIONS.map((s) => s.reviewItem).filter(Boolean)).toEqual(["evaluation", "aoi", "georef", "date"]);
  });

  it("finds the step that shows a check", () => {
    expect(sectionOfCheck("acquisition_date")).toBe("date");
    expect(sectionOfCheck("prediction_quality")).toBe("forest");
  });
});
