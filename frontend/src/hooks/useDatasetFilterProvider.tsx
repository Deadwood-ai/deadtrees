import React, { createContext, useState, useContext, useMemo } from "react";
import { AdvancedFilters } from "../components/FilterModal";

type FilterTag = "platform" | "license" | "authors_image" | "admin_level_1" | "admin_level_3" | "biome";

interface DatasetFilterContextType {
  filter: string;
  setFilter: (filter: string) => void;
  filterTag: FilterTag;
  setFilterTag: (filterTag: FilterTag) => void;
  advancedFilters: AdvancedFilters;
  setAdvancedFilters: (filters: AdvancedFilters) => void;
  sortDirection: "asc" | "desc";
  setSortDirection: (direction: "asc" | "desc") => void;
  filterByViewport: boolean;
  setFilterByViewport: (filter: boolean) => void;
}

const DatasetFilterContext = createContext<DatasetFilterContextType>({
  filter: "",
  setFilter: () => {},
  filterTag: "platform",
  setFilterTag: () => {},
  advancedFilters: {
    hasDeadwoodPrediction: false,
    hasLabels: false,
    biome: null,
    authors: [],
    platform: "",
    dateRange: [2010, new Date().getFullYear()],
  },
  setAdvancedFilters: () => {},
  sortDirection: "desc",
  setSortDirection: () => {},
  filterByViewport: true,
  setFilterByViewport: () => {},
});

export const DatasetFilterProvider = (props: { children: React.ReactNode }) => {
  const [filter, setFilter] = useState<string>("");
  const [filterTag, setFilterTag] = useState<FilterTag>("platform");
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilters>({
    hasDeadwoodPrediction: false,
    hasLabels: false,
    biome: null,
    authors: [],
    platform: "",
    dateRange: [2010, new Date().getFullYear()],
  });
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [filterByViewport, setFilterByViewport] = useState(true);

  // A fresh object here would re-render every consumer on each provider render.
  const value = useMemo(
    () => ({
      filter,
      setFilter,
      filterTag,
      setFilterTag,
      advancedFilters,
      setAdvancedFilters,
      sortDirection,
      setSortDirection,
      filterByViewport,
      setFilterByViewport,
    }),
    [filter, filterTag, advancedFilters, sortDirection, filterByViewport],
  );

  return <DatasetFilterContext.Provider value={value}>{props.children}</DatasetFilterContext.Provider>;
};

export const useDatasetFilter = () => {
  return useContext(DatasetFilterContext);
};
