import type { IDatasetArchiveItem } from "../types/dataset";

const COMBINING_MARKS = /\p{M}/gu;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Normalizes text for matching only. The original value remains untouched for
 * display, filtering values, and storage.
 */
export const normalizeSearchText = (value: string): string =>
  value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();

export const matchesSearchText = (value: string, query: string): boolean =>
  normalizeSearchText(value).includes(normalizeSearchText(query.trim()));

type SearchableDataset = Pick<
  IDatasetArchiveItem,
  "id" | "authors" | "admin_level_1" | "admin_level_2" | "admin_level_3"
>;

interface Token {
  word: string;
  start: number;
  end: number;
}

const tokenize = (text: string): Token[] =>
  [...text.matchAll(WORD)].map((match) => ({
    word: normalizeSearchText(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));

const words = (text: string) => tokenize(text).map((token) => token.word);

/** A dataset's additional information, with its words located for highlighting. */
export interface ArchiveInfo {
  text: string;
  tokens: Token[];
  words: string[];
}

/** Additional information by dataset id. */
export type ArchiveInfoIndex = ReadonlyMap<number, ArchiveInfo>;

export const buildArchiveInfoIndex = (
  rows: { id: number; additional_information: string | null }[],
): ArchiveInfoIndex =>
  new Map(
    rows
      .filter((row) => row.additional_information?.trim())
      .map((row) => {
        const text = (row.additional_information ?? "").trim();
        const tokens = tokenize(text);
        return [row.id, { text, tokens, words: tokens.map((token) => token.word) }];
      }),
  );

interface DatasetSearchIndex {
  authors: string[][];
  locationWords: string[];
}

// Normalizing ~11k datasets on every query is the bulk of a search pass, so
// each dataset's searchable words are found once and reused across queries.
const searchIndexes = new WeakMap<SearchableDataset, DatasetSearchIndex>();

const getSearchIndex = (dataset: SearchableDataset): DatasetSearchIndex => {
  let index = searchIndexes.get(dataset);
  if (!index) {
    index = {
      authors: dataset.authors?.map(words) ?? [],
      locationWords: words(
        `${dataset.admin_level_3 ?? ""} ${dataset.admin_level_2 ?? ""} ${dataset.admin_level_1 ?? ""}`,
      ),
    };
    searchIndexes.set(dataset, index);
  }
  return index;
};

// Typos allowed per query word: none for short words, where one edit already
// matches almost anything, then one, and two for long words. Words with digits
// (ids, years, plot numbers) must match exactly: 5002 is not 5001.
const allowedTypos = (term: string) =>
  /\d/.test(term) ? 0 : term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;

/**
 * Edit distance (with swapped neighbours as one edit) between `term` and the
 * closest prefix of `word`, so half-typed and slightly misspelt words match.
 * Returns `max + 1` as soon as the distance must exceed `max`.
 */
export function prefixTypoDistance(term: string, word: string, max: number): number {
  if (word.includes(term)) return 0;
  const m = term.length;
  let twoBack: number[] = [];
  let previous = Array.from({ length: m + 1 }, (_, j) => j);
  let best = previous[m];
  const rows = Math.min(word.length, m + max);
  for (let i = 1; i <= rows; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = word[i - 1] === term[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && word[i - 1] === term[j - 2] && word[i - 2] === term[j - 1]) {
        value = Math.min(value, twoBack[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    best = Math.min(best, current[m]);
    if (rowMin > max) break;
    twoBack = previous;
    previous = current;
  }
  return best;
}

/** One query, split into words, with a per-query cache of word comparisons. */
function compileQuery(query: string) {
  const terms = words(query);
  const caches = terms.map(() => new Map<string, boolean>());
  const termMatches = (index: number, word: string) => {
    const cache = caches[index];
    let hit = cache.get(word);
    if (hit === undefined) {
      const term = terms[index];
      const max = allowedTypos(term);
      hit = prefixTypoDistance(term, word, max) <= max;
      cache.set(word, hit);
    }
    return hit;
  };
  // Every query word appears, give or take a typo, among these words.
  const coversAll = (candidates: string[]) =>
    terms.every((_, i) => candidates.some((word) => termMatches(i, word)));
  return { terms, termMatches, coversAll };
}

/**
 * Builds the archive text filter for one query: every word of the query must
 * appear in a single author name, or in the place names, or in the dataset's
 * additional information. Each word may be half-typed or carry a small typo.
 */
export const createDatasetArchiveTextMatcher = (
  query: string,
  info?: ArchiveInfoIndex,
): ((dataset: SearchableDataset) => boolean) => {
  const { terms, coversAll } = compileQuery(query);
  if (terms.length === 0) return () => true;

  return (dataset) => {
    const { authors, locationWords } = getSearchIndex(dataset);
    const datasetInfo = info?.get(dataset.id);
    return (
      authors.some(coversAll) ||
      coversAll(locationWords) ||
      (!!datasetInfo && coversAll(datasetInfo.words))
    );
  };
};

export const matchesDatasetArchiveTextSearch = (
  dataset: SearchableDataset,
  query: string,
): boolean => createDatasetArchiveTextMatcher(query)(dataset);

/** Part of the additional information around the first match, matched words marked. */
export interface InfoSnippet {
  parts: { text: string; match: boolean }[];
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

const SNIPPET_LEAD = 50;
const SNIPPET_LENGTH = 180;

/**
 * Finds why a dataset's additional information matched the query, for display:
 * null unless every query word appears in it.
 */
export const createInfoSnippetFinder = (
  query: string,
  info?: ArchiveInfoIndex,
): ((datasetId: number) => InfoSnippet | null) => {
  const { terms, termMatches, coversAll } = compileQuery(query);
  return (datasetId) => {
    const datasetInfo = info?.get(datasetId);
    if (!datasetInfo || terms.length === 0) return null;
    const { text, tokens } = datasetInfo;
    if (!coversAll(datasetInfo.words)) return null;

    const matched = tokens.filter((token) => terms.some((_, i) => termMatches(i, token.word)));
    const first = matched[0]?.start ?? 0;
    // Start the window at a word boundary a little before the first match.
    const lead = tokens.filter((token) => token.start >= first - SNIPPET_LEAD)[0];
    const start = Math.min(lead?.start ?? 0, first);
    const end = Math.min(text.length, start + SNIPPET_LENGTH);

    const parts: InfoSnippet["parts"] = [];
    let cursor = start;
    for (const token of matched) {
      if (token.start < start || token.end > end) continue;
      if (token.start > cursor) parts.push({ text: text.slice(cursor, token.start), match: false });
      parts.push({ text: text.slice(token.start, token.end), match: true });
      cursor = token.end;
    }
    if (cursor < end) parts.push({ text: text.slice(cursor, end), match: false });
    return { parts, truncatedStart: start > 0, truncatedEnd: end < text.length };
  };
};
