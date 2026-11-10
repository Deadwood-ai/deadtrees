import { describe, expect, it } from "vitest";
import type { AuditVerdict, IAuditAssessment, IAuditCheckEvidence, IAuditQueueRow } from "../types/auditChecks";
import {
  auditSection,
  automatedVerdict,
  cropModelVerdict,
  deriveDecision,
  formValuesForVerdict,
  formVerdict,
  myAnswer,
  orderedCrops,
  othersAnswers,
  sectionOfField,
  sectionStatus,
  wrongVerdict,
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
  major_likelihood: null,
  modes: {},
  reason_code: null,
  reason_text: null,
  details: {},
  imported_from: null,
  created_at: "2026-11-02T00:00:00Z",
  ...overrides,
});

const queue = (overrides: Partial<IAuditQueueRow>): IAuditQueueRow => ({
  dataset_id: 7,
  check_key: "georef",
  layer: "georef",
  run_id: 10,
  version: "v1",
  mode: "review_all",
  verdict: "major",
  verdicts: {},
  needs_review: true,
  reason: "review_all",
  reviewed: false,
  ...overrides,
});

const evidence = (overrides: Partial<IAuditCheckEvidence> = {}): IAuditCheckEvidence => ({
  run: { id: 10, check_key: "georef", status: "done", inputs: {}, evidence: {}, coverage: {}, finished_at: null },
  automated: [row({})],
  queue: [queue({})],
  crops: [],
  images: [],
  ...overrides,
});

describe("automatedVerdict", () => {
  it("takes the review queue's verdict", () => {
    expect(automatedVerdict(evidence({ queue: [queue({ verdict: "unsure" })] }), "georef")).toBe("unsure");
  });

  it("prefers rule rows over model rows when the queue has no row", () => {
    const rows = [
      row({ assessor_kind: "model", verdict: "major", layer: "deadwood" }),
      row({ assessor_kind: "rule", verdict: "ok", layer: "deadwood", assessor: "pq-rule/v1" }),
      row({ assessor_kind: "model", verdict: "major", layer: "deadwood", crop_id: 3 }),
    ];
    expect(automatedVerdict(evidence({ automated: rows, queue: [] }), "deadwood")).toBe("ok");
  });

  it("takes the worst model call without a rule", () => {
    const rows = [row({ verdict: "ok" }), row({ verdict: "unsure", assessor: "b/v1" })];
    expect(automatedVerdict(evidence({ automated: rows, queue: [] }), "georef")).toBe("unsure");
    expect(automatedVerdict(undefined, "georef")).toBeNull();
  });
});

describe("answers", () => {
  const people = [
    row({ assessor_kind: "person", assessor_user_id: "me", verdict: "ok", run_id: 10 }),
    row({ assessor_kind: "person", assessor_user_id: "me", verdict: "major", run_id: 9 }),
    row({ assessor_kind: "person", assessor_user_id: "clemens", verdict: "major", run_id: 10 }),
    row({ assessor_kind: "person", assessor_user_id: "teja", verdict: "ok", run_id: 10, crop_id: 4, layer: "deadwood" }),
  ];
  const target = { checkKey: "georef" as const, layer: "georef" as const };

  it("finds my answer on the current run only", () => {
    expect(myAnswer(people, "me", 10, target)?.verdict).toBe("ok");
    expect(myAnswer(people, "me", 11, target)).toBeNull();
  });

  it("lists others' answers on the same target and run", () => {
    expect(othersAnswers(people, "me", 10, target).map((a) => a.assessor_user_id)).toEqual(["clemens"]);
  });
});

describe("sectionStatus", () => {
  const georef = auditSection("georef");

  it("says not run yet without a run", () => {
    expect(sectionStatus(georef, undefined, false)).toEqual({ label: "Not run yet", tone: "todo", needsYou: false });
  });

  it("needs you until you answer", () => {
    expect(sectionStatus(georef, evidence(), false)).toEqual({ label: "Needs you", tone: "bad", needsYou: true });
    expect(sectionStatus(georef, evidence(), true)).toEqual({ label: "Answered", tone: "ok", needsYou: false });
  });

  it("shows the call when no person is needed", () => {
    const settled = evidence({ queue: [queue({ needs_review: false, reason: null, verdict: "ok" })] });
    expect(sectionStatus(georef, settled, false)).toEqual({ label: "Good", tone: "ok", needsYou: false });
  });
});

describe("verdicts and the saved audit", () => {
  it("flips a two-way call and refuses an unsure one", () => {
    expect([wrongVerdict("ok"), wrongVerdict("major"), wrongVerdict("minor"), wrongVerdict("unsure")]).toEqual(["major", "ok", "ok", null]);
  });

  it("maps answers onto the saved audit fields and back", () => {
    const cases: [Parameters<typeof formValuesForVerdict>[0], Parameters<typeof formValuesForVerdict>[1], AuditVerdict][] = [
      ["georef", "georef", "major"],
      ["acquisition_date", "acquisition_date", "ok"],
      ["prediction_quality", "deadwood", "minor"],
      ["prediction_quality", "forest_cover", "major"],
    ];
    for (const [check, layer, verdict] of cases) {
      expect(formVerdict(check, layer, formValuesForVerdict(check, layer, verdict))).toBe(verdict);
    }
    expect(formValuesForVerdict("georef", "georef", "unsure")).toEqual({});
  });

  it("takes COG and thumbnail flags from the dataset evaluation's rule", () => {
    const rule = row({ assessor_kind: "rule", modes: { cog_issue: { likelihood: 80 }, thumbnail_issue: { likelihood: 10 } } });
    expect(formValuesForVerdict("dataset_evaluation", "image", "minor", [rule])).toEqual({ has_cog_issue: true, has_thumbnail_issue: false });
    expect(formValuesForVerdict("dataset_evaluation", "image", "ok", [rule])).toEqual({ has_cog_issue: false, has_thumbnail_issue: false });
    expect(formValuesForVerdict("dataset_evaluation", "image", "major", [rule])).toEqual({});
  });
});

describe("deriveDecision", () => {
  const complete = {
    has_cog_issue: false,
    has_thumbnail_issue: false,
    is_georeferenced: true,
    has_valid_acquisition_date: true,
    has_valid_phenology: true,
    deadwood_quality: "great" as const,
  };

  it("excludes on the dataset evaluation", () => {
    expect(deriveDecision(complete, "major").disposition).toBe("exclude_completely");
  });

  it("makes any fixable finding a fix and names it", () => {
    expect(deriveDecision({ ...complete, is_georeferenced: false }, "ok")).toEqual({
      disposition: "fixable_issues",
      because: ["georeferencing poor"],
      open: [],
    });
  });

  it("is ready only when every section is answered", () => {
    expect(deriveDecision(complete, "ok").disposition).toBe("no_issues");
    const open = deriveDecision({ ...complete, has_valid_phenology: undefined }, null);
    expect(open).toEqual({ disposition: null, because: [], open: ["phenology"] });
  });

  it("does not let phenology decide", () => {
    expect(deriveDecision({ ...complete, has_valid_phenology: false }, "ok").disposition).toBe("no_issues");
  });
});

describe("crops", () => {
  const crop = (id: number, sets: string[]) => ({ id, crop_sets: sets, geometry: { type: "Polygon" as const, coordinates: [] }, mpp: 0.05, size_px: 1024, selection: {} });

  it("numbers the exclude set first", () => {
    const ordered = orderedCrops(evidence({ crops: [crop(5, ["training"]), crop(9, ["exclude"]), crop(2, ["training", "exclude"])] }));
    expect(ordered.map((c) => c.id)).toEqual([2, 9, 5]);
  });

  it("takes the models' worst call on a crop", () => {
    const rows = [
      row({ crop_id: 2, layer: "deadwood", verdict: "minor" }),
      row({ crop_id: 2, layer: "forest_cover", verdict: "major" }),
      row({ crop_id: 3, layer: "deadwood", verdict: "major" }),
    ];
    expect(cropModelVerdict(evidence({ automated: rows }), 2, ["deadwood"])).toBe("minor");
    expect(cropModelVerdict(evidence({ automated: rows }), 2, ["deadwood", "forest_cover"])).toBe("major");
  });
});

describe("independent reviews", () => {
  it("still needs you after another reviewer answered", () => {
    const answeredByOthers = evidence({ queue: [queue({ needs_review: false, reviewed: true })] });
    expect(sectionStatus(auditSection("georef"), answeredByOthers, false).needsYou).toBe(true);
  });
});

describe("section definitions", () => {
  it("lets a reviewer pick any verdict where a check has three", () => {
    expect(auditSection("evaluation").verdicts).toEqual(["ok", "minor", "major"]);
    expect(auditSection("georef").verdicts).toEqual(["ok", "major"]);
  });

  it("finds the section that holds a saved-audit field", () => {
    expect(sectionOfField("has_cog_issue")).toBe("evaluation");
    expect(sectionOfField("deadwood_quality")).toBe("prediction");
    expect(sectionOfField("has_valid_phenology")).toBe("phenology");
    expect(sectionOfField("final_assessment")).toBeNull();
  });
});
