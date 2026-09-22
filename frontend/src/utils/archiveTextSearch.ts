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

export const matchesDatasetArchiveTextSearch = (
  dataset: Pick<
    IDatasetArchiveItem,
    "authors" | "admin_level_1" | "admin_level_2" | "admin_level_3"
  >,
  query: string,
): boolean => {
  const searchTerms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (searchTerms.length === 0) return true;

  const authorMatch =
    dataset.authors?.some((author) => {
      const normalizedAuthor = normalizeSearchText(author);
      return searchTerms.every((term) => normalizedAuthor.includes(term));
    }) ?? false;

  const locationWords = normalizeSearchText(
    `${dataset.admin_level_3 ?? ""}, ${dataset.admin_level_2 ?? ""}, ${dataset.admin_level_1 ?? ""}`,
  )
    .split(/[\s,]+/)
    .filter(Boolean);
  const locationMatch = searchTerms.every((term) =>
    locationWords.some((word) => word.includes(term)),
  );

  return authorMatch || locationMatch;
};
