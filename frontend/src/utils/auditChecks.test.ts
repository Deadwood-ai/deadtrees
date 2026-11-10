import { describe, expect, it } from "vitest";
import type { IAuditAssessment, IAuditCheckEvidence, IAuditQueueRow } from "../types/auditChecks";
import type { IGeorefCheck } from "../types/georefCheck";
import {
  answeredFormValues,
  auditSection,
  automatedVerdict,
  cropModelVerdict,
  deriveDecision,
  formValuesForVerdict,
  legacySectionStatus,
  mergeAnswers,
  myAnswer,
  orderedCrops,
  othersAnswers,
  sectionOfField,
  sectionStatus,
  stepCrop,
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
  reason_code: null,
  reason_text: null,
  details: {},
  ...overrides,
});

const person = (userId: string, overrides: Partial<IAuditAssessment> = {}) =>
  row({ assessor_kind: "person", assessor_user_id: userId, assessor: userId, model: null, prompt_version: null, ...overrides });

const queue = (overrides: Partial<IAuditQueueRow>): IAuditQueueRow => ({
  dataset_id: 7,
  check_key: "georef",
  layer: "georef",
  run_id: 10,
  verdict: "major",
  reason: "review_all",
  ...overrides,
});

const evidence = (overrides: Partial<IAuditCheckEvidence> = {}): IAuditCheckEvidence => ({
  run: { id: 10, check_key: "georef", inputs: {} },
  automated: [row({})],
  queue: [queue({})],
  crops: [],
  images: [],
  ...overrides,
});

describe("automatedVerdict", () => {
  it("is the review queue's verdict for the layer", () => {
    const both = evidence({ queue: [queue({ layer: "deadwood", verdict: "unsure" }), queue({ layer: "forest_cover", verdict: "ok" })] });
    expect(automatedVerdict(both, "deadwood")).toBe("unsure");
    expect(automatedVerdict(both, "forest_cover")).toBe("ok");
  });

  it("is null without a run or a call on the layer", () => {
    expect(automatedVerdict(undefined, "georef")).toBeNull();
    expect(automatedVerdict(evidence({ queue: [] }), "georef")).toBeNull();
  });
});

describe("answers", () => {
  const people = [
    person("me", { verdict: "ok", run_id: 10 }),
    person("clemens", { verdict: "major", run_id: 10 }),
    person("teja", { verdict: "ok", run_id: 10, crop_id: 4, layer: "deadwood" }),
  ];
  const target = { checkKey: "georef" as const, layer: "georef" as const };

  it("finds my answer on the current run only", () => {
    expect(myAnswer(people, "me", 10, target)?.verdict).toBe("ok");
    expect(myAnswer(people, "me", 11, target)).toBeNull();
  });

  it("lists others' answers on the same target and run", () => {
    expect(othersAnswers(people, "me", 10, target).map((a) => a.assessor_user_id)).toEqual(["clemens"]);
  });

  it("replaces my earlier answer on a target and keeps everyone else's", () => {
    const changed = person("me", { id: 9, verdict: "major", run_id: 10 });
    const merged = mergeAnswers(people, [changed]);
    expect(merged).toHaveLength(3);
    expect(myAnswer(merged, "me", 10, target)?.id).toBe(9);
    expect(othersAnswers(merged, "me", 10, target)).toHaveLength(1);
    // an answer on another crop is a new target
    expect(mergeAnswers(people, [person("teja", { crop_id: 5, layer: "deadwood" })])).toHaveLength(4);
  });
});

describe("sectionStatus", () => {
  const georef = auditSection("georef");

  it("needs you until you answer", () => {
    expect(sectionStatus(georef, evidence(), false)).toEqual({ label: "Needs you", tone: "bad", needsYou: true });
    expect(sectionStatus(georef, evidence(), true)).toEqual({ label: "Answered", tone: "ok", needsYou: false });
  });

  it("shows the call when the result is applied without review", () => {
    const settled = evidence({ queue: [queue({ reason: null, verdict: "ok" })] });
    expect(sectionStatus(georef, settled, false)).toEqual({ label: "Good", tone: "ok", needsYou: false });
  });
});

describe("legacySectionStatus", () => {
  const inputs = { hasAOI: false, phenology: undefined, georefCheck: null, dateEstimate: null, reviewItems: [] };
  const georefCheck = { decision: "poor", evidence_level: "gross", reason: "gross_offset", p90_m: 40, reference_evidence: [] } as unknown as IGeorefCheck;

  it("says not run yet for a check without any result", () => {
    for (const id of ["evaluation", "georef", "date", "prediction"] as const) {
      expect(legacySectionStatus(id, inputs)).toEqual({ label: "Not run yet", tone: "todo", needsYou: false });
    }
  });

  it("reads the AOI and the manual phenology answer", () => {
    expect(legacySectionStatus("aoi", inputs).label).toBe("Missing");
    expect(legacySectionStatus("aoi", { ...inputs, hasAOI: true }).label).toBe("Set");
    expect(legacySectionStatus("phenology", inputs).label).toBe("Manual");
    expect(legacySectionStatus("phenology", { ...inputs, phenology: false })).toEqual({ label: "Out of season", tone: "warn", needsYou: false });
  });

  it("shows the older georeferencing check, and asks for you when it is under re-review", () => {
    expect(legacySectionStatus("georef", { ...inputs, georefCheck })).toEqual({ label: "Poor", tone: "bad", needsYou: false });
    const reviewItems = [{ item: "is_georeferenced" }] as never[];
    expect(legacySectionStatus("georef", { ...inputs, georefCheck, reviewItems }).needsYou).toBe(true);
  });
});

describe("verdicts and the saved audit", () => {
  it("flips a two-way call and refuses an unsure one", () => {
    expect([wrongVerdict("ok"), wrongVerdict("major"), wrongVerdict("minor"), wrongVerdict("unsure")]).toEqual(["major", "ok", "ok", null]);
  });

  it("maps an answer onto the saved-audit field it decides", () => {
    expect(formValuesForVerdict("georef", "georef", "major")).toEqual({ is_georeferenced: false });
    expect(formValuesForVerdict("acquisition_date", "acquisition_date", "ok")).toEqual({ has_valid_acquisition_date: true });
    expect(formValuesForVerdict("prediction_quality", "deadwood", "minor")).toEqual({ deadwood_quality: "sentinel_ok" });
    expect(formValuesForVerdict("prediction_quality", "forest_cover", "major")).toEqual({ forest_cover_quality: "bad" });
    expect(formValuesForVerdict("georef", "georef", "unsure")).toEqual({});
  });

  it("leaves the COG and thumbnail fields to the reviewer", () => {
    expect(formValuesForVerdict("dataset_evaluation", "image", "minor")).toEqual({});
  });

  it("collects the fields my answers on the current runs decide", () => {
    const checks = {
      available: true,
      checks: {
        georef: evidence(),
        prediction_quality: evidence({ run: { id: 20, check_key: "prediction_quality", inputs: {} } }),
      },
      people: [
        person("me", { verdict: "ok" }),
        person("me", { check_key: "prediction_quality", layer: "deadwood", run_id: 20, verdict: "major" }),
        // an answer on an earlier run and someone else's answer decide nothing
        person("me", { check_key: "prediction_quality", layer: "forest_cover", run_id: 19, verdict: "major" }),
        person("clemens", { check_key: "prediction_quality", layer: "forest_cover", run_id: 20, verdict: "major" }),
      ],
    };
    expect(answeredFormValues(checks, "me")).toEqual({ is_georeferenced: true, deadwood_quality: "bad" });
    expect(answeredFormValues(undefined, "me")).toEqual({});
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
  const crop = (id: number, sets: string[]) => ({ id, crop_sets: sets, geometry: { type: "Polygon" as const, coordinates: [] } });

  it("numbers the exclude set first", () => {
    const ordered = orderedCrops({ crops: [crop(5, ["training"]), crop(9, ["exclude"]), crop(2, ["training", "exclude"])] });
    expect(ordered.map((c) => c.id)).toEqual([2, 9, 5]);
  });

  it("takes the models' worst call on a crop", () => {
    const automated = [
      row({ crop_id: 2, layer: "deadwood", verdict: "minor" }),
      row({ crop_id: 2, layer: "forest_cover", verdict: "major" }),
      row({ crop_id: 3, layer: "deadwood", verdict: "major" }),
    ];
    expect(cropModelVerdict({ automated }, 2, ["deadwood"])).toBe("minor");
    expect(cropModelVerdict({ automated }, 2, ["deadwood", "forest_cover"])).toBe("major");
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
