import React, { createContext, useState, useContext, useMemo } from "react";
import { EMPTY_ARCHIVE_FILTERS, type ArchiveFilters } from "../utils/datasetArchiveFilters";

// Lives above the router outlet so the archive keeps its filters when a visitor
// opens a dataset and comes back.
interface DatasetFilterContextType {
  filters: ArchiveFilters;
  setFilters: (filters: ArchiveFilters) => void;
  sortDirection: "asc" | "desc";
  setSortDirection: (direction: "asc" | "desc") => void;
  filterByViewport: boolean;
  setFilterByViewport: (filter: boolean) => void;
}

const DatasetFilterContext = createContext<DatasetFilterContextType>({
  filters: EMPTY_ARCHIVE_FILTERS,
  setFilters: () => {},
  sortDirection: "desc",
  setSortDirection: () => {},
  filterByViewport: true,
  setFilterByViewport: () => {},
});

export const DatasetFilterProvider = (props: { children: React.ReactNode }) => {
  const [filters, setFilters] = useState<ArchiveFilters>(EMPTY_ARCHIVE_FILTERS);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [filterByViewport, setFilterByViewport] = useState(true);

  // A fresh object here would re-render every consumer on each provider render.
  const value = useMemo(
    () => ({
      filters,
      setFilters,
      sortDirection,
      setSortDirection,
      filterByViewport,
      setFilterByViewport,
    }),
    [filters, sortDirection, filterByViewport],
  );

  return <DatasetFilterContext.Provider value={value}>{props.children}</DatasetFilterContext.Provider>;
};

export const useDatasetFilter = () => {
  return useContext(DatasetFilterContext);
};
