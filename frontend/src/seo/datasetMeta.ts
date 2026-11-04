import type { IDataset } from "../types/dataset";
import { fixTextEncoding } from "../utils/textUtils";
import { SITE_NAME, SITE_ORIGIN, type PageMeta } from "./pageMeta";

type DatasetFields = Pick<
  IDataset,
  | "id"
  | "license"
  | "platform"
  | "authors"
  | "aquisition_year"
  | "aquisition_month"
  | "aquisition_day"
  | "citation_doi"
  | "admin_level_1"
  | "admin_level_2"
  | "admin_level_3"
>;

const LICENSE_URLS: Record<string, string> = {
  "CC BY": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY-SA": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC BY-NC-SA": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

const placeOf = (dataset: DatasetFields) =>
  [
    dataset.admin_level_3 || dataset.admin_level_2,
    dataset.admin_level_1,
  ]
    .filter(Boolean)
    .join(", ");

const isoDateOf = ({
  aquisition_year: year,
  aquisition_month: month,
  aquisition_day: day,
}: DatasetFields) => {
  if (!year) return undefined;
  if (!month) return `${year}`;
  const monthPart = `${year}-${String(month).padStart(2, "0")}`;
  return day ? `${monthPart}-${String(day).padStart(2, "0")}` : monthPart;
};

/** The heading a reader and a search engine get for one dataset page. */
export const datasetHeading = (dataset: DatasetFields): string => {
  const place = placeOf(dataset) || `dataset ${dataset.id}`;
  const year = dataset.aquisition_year ? ` (${dataset.aquisition_year})` : "";
  return `Aerial forest orthophoto of ${place}${year}`;
};

export const datasetPageMeta = (dataset: DatasetFields): Partial<PageMeta> => {
  const place = placeOf(dataset);
  const date = isoDateOf(dataset);
  const platform = dataset.platform || "aerial";
  const description = [
    `${platform[0].toUpperCase()}${platform.slice(1)} orthophoto of a forest`,
    place ? ` in ${place}` : "",
    date ? `, captured ${date}` : "",
    ", with standing deadwood and tree cover maps. ",
    dataset.license ? `License: ${dataset.license}.` : "",
  ]
    .join("")
    .trim();

  return {
    title: `${datasetHeading(dataset)} | ${SITE_NAME}`,
    description,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: datasetHeading(dataset),
      description,
      url: `${SITE_ORIGIN}/dataset/${dataset.id}`,
      license: LICENSE_URLS[dataset.license] ?? dataset.license,
      isAccessibleForFree: true,
      includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME },
      ...(date ? { temporalCoverage: date } : {}),
      ...(place
        ? { spatialCoverage: { "@type": "Place", name: place } }
        : {}),
      ...(dataset.authors?.length
        ? {
            creator: dataset.authors.map((name) => ({
              "@type": "Person",
              name: fixTextEncoding(name),
            })),
          }
        : {}),
      ...(dataset.citation_doi ? { citation: dataset.citation_doi } : {}),
    },
  };
};
