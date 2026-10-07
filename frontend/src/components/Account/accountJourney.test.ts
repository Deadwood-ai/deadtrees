import { describe, expect, it } from "vitest";
import { computeAccountJourney, type JourneyDataset } from "./accountJourney";
import { avatarFill, avatarInitials } from "./avatarInitials";

const ready: JourneyDataset = {
  id: 1,
  file_name: "a.tif",
  data_access: "public",
  current_status: "idle",
  is_upload_done: true,
  is_ortho_done: true,
  is_metadata_done: true,
  is_cog_done: true,
  is_thumbnail_done: true,
  is_deadwood_done: true,
  is_forest_cover_done: true,
};

const byKey = (datasets: JourneyDataset[], inReview: number[] = []) =>
  Object.fromEntries(computeAccountJourney(datasets, inReview).map((step) => [step.key, step]));

describe("computeAccountJourney", () => {
  it("counts an empty account as zero without dividing by zero", () => {
    const steps = byKey([]);
    expect(steps.upload.value).toBe(0);
    expect(steps.process.progress).toBe(0);
  });

  it("splits datasets across upload, process and publish", () => {
    const steps = byKey(
      [
        ready,
        { ...ready, id: 2, data_access: "private", freidata_doi: "10.1/x" },
        { ...ready, id: 3, current_status: "cog_processing" },
        { ...ready, id: 4, has_error: true },
        { ...ready, id: 5, current_status: "audit_in_progress" },
      ],
      [5],
    );
    expect(steps.upload.value).toBe(5);
    expect(steps.upload.details).toEqual([
      { label: "Public", value: 4 },
      { label: "Private or view only", value: 1 },
    ]);
    expect(steps.process.value).toBe(3);
    expect(steps.process.progress).toBeCloseTo(0.6);
    expect(steps.process.details).toEqual([
      { label: "Processing now", value: 1 },
      { label: "Stopped", value: 1 },
    ]);
    expect(steps.publish.value).toBe(1);
    expect(steps.publish.details).toEqual([
      { label: "In review", value: 1 },
      { label: "Results ready, no DOI yet", value: 1 },
    ]);
  });
});

describe("avatar initials", () => {
  it("takes the first and last name part", () => {
    expect(avatarInitials("anna.maria-mueller@example.com")).toBe("AM");
    expect(avatarInitials("jj1049@example.com")).toBe("JJ");
    expect(avatarInitials("")).toBe("?");
  });

  it("keeps the same fill for the same email", () => {
    expect(avatarFill("A@x.org ")).toBe(avatarFill("a@x.org"));
  });
});
