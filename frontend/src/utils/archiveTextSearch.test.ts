import { describe, expect, it } from "vitest";

import {
  createDatasetArchiveTextMatcher,
  matchesDatasetArchiveTextSearch,
  matchesSearchText,
  normalizeSearchText,
} from "./archiveTextSearch";

const dataset = {
  authors: ["Primary Author", "Jose\u0301 García"],
  admin_level_1: "España",
  admin_level_2: "Andalucía",
  admin_level_3: "Sierra Nevada",
};

describe("archive text search", () => {
  it("matches a non-first author without changing the stored name", () => {
    expect(matchesDatasetArchiveTextSearch(dataset, "garcia")).toBe(true);
    expect(dataset.authors[1]).toBe("Jose\u0301 García");
  });

  it("matches composed and decomposed accents case-insensitively", () => {
    expect(matchesDatasetArchiveTextSearch(dataset, "JOSÉ GARCÍA")).toBe(true);
    expect(matchesDatasetArchiveTextSearch(dataset, "jose\u0301 garci\u0301a")).toBe(true);
    expect(matchesDatasetArchiveTextSearch(dataset, "e")).toBe(true);
  });

  it("uses the same accent-insensitive comparison for author suggestions", () => {
    expect(matchesSearchText("José García", "garcia")).toBe(true);
    expect(matchesSearchText("Jose\u0301 Garci\u0301a", "JOSÉ")).toBe(true);
  });

  it("keeps normalization out of the display value", () => {
    const displayName = "José García";
    expect(normalizeSearchText(displayName)).toBe("jose garcia");
    expect(displayName).toBe("José García");
  });

  it("reuses one matcher across datasets and queries without changing results", () => {
    const other = { ...dataset, authors: ["Different Author"], admin_level_3: "Freiburg im Breisgau" };
    for (const query of ["garcia", "sierra andalucia", "primary garcia", "freiburg breisgau", " ", "nowhere"]) {
      const matches = createDatasetArchiveTextMatcher(query);
      for (const item of [dataset, other]) {
        expect(matches(item)).toBe(matchesDatasetArchiveTextSearch(item, query));
      }
    }
    expect(createDatasetArchiveTextMatcher("primary garcia")(dataset)).toBe(false);
    expect(createDatasetArchiveTextMatcher("sierra andalucia")(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("freiburg")(dataset)).toBe(false);
  });
});
