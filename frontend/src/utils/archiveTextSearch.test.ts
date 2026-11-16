import { describe, expect, it } from "vitest";

import {
  buildArchiveInfoIndex,
  createDatasetArchiveTextMatcher,
  createInfoSnippetFinder,
  matchesDatasetArchiveTextSearch,
  matchesSearchText,
  normalizeSearchText,
  prefixTypoDistance,
} from "./archiveTextSearch";

const dataset = {
  id: 1,
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
    const other = { ...dataset, id: 2, authors: ["Different Author"], admin_level_3: "Freiburg im Breisgau" };
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

  it("matches the additional information once it is loaded", () => {
    const notes = buildArchiveInfoIndex([
      { id: 1, additional_information: "Bark beetle Décline after drought; FLUX tower site" },
      { id: 2, additional_information: null },
    ]);
    expect(createDatasetArchiveTextMatcher("decline", notes)(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("flux tower", notes)(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("flux decline", notes)(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("flux windthrow", notes)(dataset)).toBe(false);
    // Without the notes loaded yet, authors and places still match.
    expect(createDatasetArchiveTextMatcher("decline")(dataset)).toBe(false);
    expect(createDatasetArchiveTextMatcher("garcia", notes)(dataset)).toBe(true);
    expect(notes.has(2)).toBe(false);
  });

  it("forgives a typo or a swapped pair in longer words, but not in short ones", () => {
    expect(createDatasetArchiveTextMatcher("garica")(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("nevda")(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("andalusia")(dataset)).toBe(true);
    expect(createDatasetArchiveTextMatcher("sierra nevda")(dataset)).toBe(true);
    // Three letters: no typo allowed, or "jos" would match "joe", "job", ...
    expect(createDatasetArchiveTextMatcher("jso")(dataset)).toBe(false);
    expect(createDatasetArchiveTextMatcher("garxyz")(dataset)).toBe(false);
  });

  it("matches half-typed words, with a typo, against word starts", () => {
    expect(prefixTypoDistance("decl", "decline", 1)).toBe(0);
    expect(prefixTypoDistance("dclin", "decline", 1)).toBe(1);
    expect(prefixTypoDistance("drougth", "drought", 1)).toBe(1);
    expect(prefixTypoDistance("flux", "beetle", 1)).toBeGreaterThan(1);
  });

  it("finds a typo in the additional information and marks the matched words", () => {
    const info = buildArchiveInfoIndex([
      {
        id: 1,
        additional_information:
          "Plot established in 2019 as part of a long-term monitoring network. Strong spruce décline after the 2018 drought, eddy covariance flux tower nearby.",
      },
    ]);
    expect(createDatasetArchiveTextMatcher("declne", info)(dataset)).toBe(true);
    const snippet = createInfoSnippetFinder("flux declne", info)(1);
    expect(snippet?.parts.filter((part) => part.match).map((part) => part.text)).toEqual(["décline", "flux"]);
    expect(snippet?.truncatedStart).toBe(true);
    expect(snippet?.parts.map((part) => part.text).join("")).toContain("Strong spruce décline after");
    // Author-only matches show no snippet.
    expect(createInfoSnippetFinder("garcia", info)(1)).toBeNull();
    expect(createInfoSnippetFinder("decline", info)(2)).toBeNull();
  });
});
