import type { IDatasetArchiveItem } from "../types/dataset";

const COMBINING_MARKS = /\p{M}/gu;

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
  "authors" | "admin_level_1" | "admin_level_2" | "admin_level_3"
>;

interface DatasetSearchIndex {
  authors: string[];
  locationWords: string[];
}

// Normalizing ~7.5k datasets on every query is the bulk of a search pass, so
// each dataset's searchable text is normalized once and reused across queries.
const searchIndexes = new WeakMap<SearchableDataset, DatasetSearchIndex>();

const getSearchIndex = (dataset: SearchableDataset): DatasetSearchIndex => {
  let index = searchIndexes.get(dataset);
  if (!index) {
    index = {
      authors: dataset.authors?.map(normalizeSearchText) ?? [],
      locationWords: normalizeSearchText(
        `${dataset.admin_level_3 ?? ""}, ${dataset.admin_level_2 ?? ""}, ${dataset.admin_level_1 ?? ""}`,
      )
        .split(/[\s,]+/)
        .filter(Boolean),
    };
    searchIndexes.set(dataset, index);
  }
  return index;
};

/**
 * Builds the archive text filter for one query: every term must appear in a
 * single author name, or each term in some word of the place names.
 */
export const createDatasetArchiveTextMatcher = (
  query: string,
): ((dataset: SearchableDataset) => boolean) => {
  const searchTerms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (searchTerms.length === 0) return () => true;

  return (dataset) => {
    const { authors, locationWords } = getSearchIndex(dataset);
    return (
      authors.some((author) =>
        searchTerms.every((term) => author.includes(term)),
      ) ||
      searchTerms.every((term) =>
        locationWords.some((word) => word.includes(term)),
      )
    );
  };
};

export const matchesDatasetArchiveTextSearch = (
  dataset: SearchableDataset,
  query: string,
): boolean => createDatasetArchiveTextMatcher(query)(dataset);
