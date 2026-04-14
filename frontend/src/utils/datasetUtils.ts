import { IDataset } from "../types/dataset";
import { fixAuthorNamesEncoding } from "./textUtils";

/**
 * Checks if a dataset is from GeoNadir provider
 * @param dataset - The dataset to check
 * @returns true if dataset is from GeoNadir, false otherwise
 */
export const isGeonadirDataset = (dataset: IDataset): boolean => {
  const geonadirBaseUrl = "https://data.geonadir.com/image-collection-details/";

  // Check both citation_doi and freidata_doi fields
  const citationDoi = dataset.citation_doi?.toLowerCase() || "";
  const freidataDoi = dataset.freidata_doi?.toLowerCase() || "";

  return citationDoi.includes(geonadirBaseUrl.toLowerCase()) || freidataDoi.includes(geonadirBaseUrl.toLowerCase());
};

/**
 * Gets display text for authors, adding "via GeoNadir" suffix for GeoNadir datasets
 * @param authors - Array of author names
 * @param isGeonadir - Whether the dataset is from GeoNadir
 * @returns Formatted author display text
 */
export const getAuthorDisplayText = (authors: string[] | null, isGeonadir: boolean): string => {
  if (!authors || authors.length === 0) return "";

  // Clean the author names to fix encoding issues
  const cleanedAuthors = fixAuthorNamesEncoding(authors);
  if (cleanedAuthors.length === 0) return "";

  const baseText =
    cleanedAuthors.length === 1
      ? cleanedAuthors[0]
      : `${cleanedAuthors[0]}${cleanedAuthors[0].length > 18 ? "..." : ""} +${cleanedAuthors.length - 1}`;

  return isGeonadir ? `${baseText} via GeoNadir` : baseText;
};

/**
 * Gets truncated author display for DatasetDetails component
 * @param authors - Array of author names
 * @param isGeonadir - Whether the dataset is from GeoNadir
 * @returns Formatted author display text with length limits
 */
export const getTruncatedAuthorDisplay = (authors: string[] | null, isGeonadir: boolean): string => {
  if (!authors || authors.length === 0) return "";

  // Clean the author names to fix encoding issues
  const cleanedAuthors = fixAuthorNamesEncoding(authors);
  if (cleanedAuthors.length === 0) return "";

  const firstAuthor = cleanedAuthors[0].slice(0, 14) + (cleanedAuthors[0].length > 14 ? "..." : "");
  const additionalCount = cleanedAuthors.length > 1 ? ` +${cleanedAuthors.length - 1}` : "";
  const baseText = firstAuthor + additionalCount;

  return isGeonadir ? `${baseText} via GeoNadir` : baseText;
};
