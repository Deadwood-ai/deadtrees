import { useMemo } from "react";
import { IDataset } from "../types/dataset";
import { useDatasetFilter } from "./useDatasetFilterProvider";

export function useFilteredDatasets(datasets: IDataset[] | undefined) {
  const { filter, filterTag, advancedFilters } = useDatasetFilter();

  const filteredData = useMemo(() => {
    if (!datasets) return datasets;

    // First apply the simple filter if it exists
    let result = datasets;

    if (filter) {
      result = result.filter((item) => {
        switch (filterTag) {
          case "platform":
            return item.platform === filter;
          case "license":
            return item.license === filter;
          case "authors_image":
            return item.authors?.includes(filter as string);
          case "admin_level_1":
            return item.admin_level_1 === filter;
          case "admin_level_3":
            return item.admin_level_3 === filter;
          case "biome":
            if (filter === "Unknown") {
              return !item.biome_name;
            }
            return item.biome_name === filter;
          default:
            return false;
        }
      });
    }

    // Then apply advanced filters
    if (advancedFilters.hasDeadwoodPrediction) {
      result = result.filter((item) => item.has_deadwood_prediction);
    }

    if (advancedFilters.hasLabels) {
      result = result.filter((item) => item.has_labels);
    }

    if (advancedFilters.biome) {
      result = result.filter((item) => item.biome_name === advancedFilters.biome);
    }

    if (advancedFilters.authors?.length > 0) {
      result = result.filter((item) => item.authors?.some((author) => advancedFilters.authors.includes(author)));
    }

    if (advancedFilters.platform && advancedFilters.platform !== "") {
      result = result.filter((item) => item.platform === advancedFilters.platform);
    }

    if (advancedFilters.dateRange) {
      const [startYear, endYear] = advancedFilters.dateRange;
      result = result.filter((item) => {
        const year = parseInt(item.aquisition_year);
        return year >= startYear && year <= endYear;
      });
    }

    return result;
  }, [datasets, filter, filterTag, advancedFilters]);

  return {
    filteredData,
  };
}
