import { useMemo, useState, useEffect, useCallback } from "react";
import { Button, Tag, Spin, Tooltip, Checkbox, Drawer } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  FilterOutlined,
  CloseOutlined,
  UploadOutlined,
  UnorderedListOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";

import DataList from "../components/DataList";
import DatasetMapOL, {
  type DatasetMapColorMode,
  type DatasetMapViewPadding,
} from "../components/DatasetMap/DatasetMap";
import DatasetTimelineControl from "../components/DatasetMap/DatasetTimelineControl";
import { useNavigate } from "react-router-dom";
import { useFilteredDatasets } from "../hooks/useFilteredDatasets";
import { usePublicDatasetArchiveItems } from "../hooks/useDatasets";
import { useUploadTimeline } from "../hooks/useUploadTimeline";
import FilterModal, { AdvancedFilters } from "../components/FilterModal";
import { useDatasetFilter } from "../hooks/useDatasetFilterProvider";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDesktopOnlyFeature } from "../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../hooks/useAnalytics";
import { useArchiveSearch } from "../hooks/useArchiveSearch";
import ArchiveSearch from "../components/DatasetMap/ArchiveSearch";
import { matchesDatasetArchiveTextSearch } from "../utils/archiveTextSearch";

type FilterTag =
  | "platform"
  | "license"
  | "authors_image"
  | "admin_level_1"
  | "admin_level_3"
  | "biome";

const SIDEBAR_LEFT_PX = 16;
const SIDEBAR_WIDTH_PX = 360;
const SIDEBAR_BUTTON_TOP_PX = 108;
const FLOAT_BUTTON_SIZE_PX = 36;
// Map area hidden by the header, sidebar and timeline, so fitted views stay visible.
const MAP_EDGE_PADDING_PX = 24;
const MAP_TOP_PADDING_PX = 96;
const MAP_BOTTOM_PADDING_PX = 72;

export default function Dataset() {
  const navigate = useNavigate();
  const { data: allData } = usePublicDatasetArchiveItems();

  // The "DB as of" timeline axis is derived from the full, unfiltered dataset so
  // that no filter (tag, advanced, or text search) ever changes the available
  // periods. The timeline is applied first; all filters apply on top of the
  // time-limited slice below.
  const {
    periods,
    selectedPeriod,
    setSelectedPeriod,
    displayData: timeFilteredData,
    cumulativeCount,
    addedInQuarter,
  } = useUploadTimeline(allData ?? null);

  const { filteredData } = useFilteredDatasets(timeFilteredData ?? undefined);

  // Get filter state from context
  const {
    filter,
    setFilter,
    setFilterTag,
    advancedFilters,
    setAdvancedFilters,
    sortDirection,
    setSortDirection,
    filterByViewport,
    setFilterByViewport,
  } = useDatasetFilter();

  const [hoveredItem, setHoveredItem] = useState<number | null>(null);
  const [visibleFeatures, setVisibleFeatures] = useState<string[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [isFilterModalVisible, setIsFilterModalVisible] = useState(false);
  const [isMobileListOpen, setIsMobileListOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const colorMode: DatasetMapColorMode = "timeline";
  const isMobile = useIsMobile();
  const { runDesktopOnlyAction } = useDesktopOnlyFeature();
  const { track } = useAnalytics("dataset_archive");
  // Incremented on explicit filter actions to trigger map zoom
  const [filterZoomTrigger, setFilterZoomTrigger] = useState(0);

  // Open-vocabulary (CLIP) search is public; the ranking RPC only returns
  // datasets visible to the caller.
  const search = useArchiveSearch();
  const { semantic } = search;
  const searchInput = search.text;

  // Debounced search handler
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchValue(searchInput);
    }, 300); // 300ms delay

    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    track("dataset_archive_viewed", {});
  }, [track]);

  useEffect(() => {
    if (!searchValue.trim()) return;
    track("dataset_search_used", {
      search_length: searchValue.trim().length,
    });
  }, [searchValue, track]);

  const toggleSort = () => {
    setSortDirection(sortDirection === "asc" ? "desc" : "asc");
  };

  // Stable identity keeps the memoised DataList/DatasetMapOL from re-rendering on
  // every keystroke in the search box.
  const handleFilterClick = useCallback(
    (filterValue: string, filterType: FilterTag) => {
      setFilter(filterValue);
      setFilterTag(filterType);
      setFilterZoomTrigger((n) => n + 1);
      track("dataset_filter_applied", {
        filter_type: filterType,
        filter_value: filterValue,
      });
    },
    [setFilter, setFilterTag, track],
  );

  const handleMapInteracted = useCallback(() => {
    track("dataset_map_interacted", { interaction_type: "move" });
  }, [track]);

  const handleFilterButtonClick = () => {
    setIsFilterModalVisible(true);
  };

  const handleApplyFilters = (newFilters: AdvancedFilters) => {
    setAdvancedFilters(newFilters);
    setFilterZoomTrigger((n) => n + 1);
    const appliedFilters = Object.entries(newFilters).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined && value !== "";
    });
    track("dataset_filter_applied", {
      filter_type: appliedFilters.map(([key]) => key).join(",") || "advanced",
      filter_value: String(appliedFilters.length),
    });
  };

  const activeTextSearch = search.mode === "text" && searchInput ? searchValue : "";

  // Text/semantic search and sorting are applied on top of the already
  // filtered data, so they affect only which datasets are shown — never the
  // timeline.
  const displayData = useMemo(() => {
    if (!filteredData) return null;

    const filtered = filteredData.filter((d) => {
      // If no search value, return true for the base condition
      if (!activeTextSearch.trim()) return true;

      return matchesDatasetArchiveTextSearch(d, activeTextSearch);
    });

    // When a semantic query is active, restrict to matched datasets and order
    // by relevance score (most relevant first), overriding the id/date sort.
    if (semantic.scores) {
      const scores = semantic.scores;
      return filtered
        .filter((d) => scores.has(d.id))
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
    }

    // Sort by ID instead of date (ID represents order of addition to database)
    return filtered.sort((a, b) => {
      return sortDirection === "asc" ? a.id - b.id : b.id - a.id;
    });
  }, [filteredData, activeTextSearch, sortDirection, semantic.scores]);

  // Reset visibleFeatures when data changes
  useEffect(() => {
    if (displayData?.length && displayData.length > 0) {
      // When data changes, start with all features visible
      setVisibleFeatures(displayData.map((item) => item.id.toString()));
    }
  }, [displayData]);

  const filterDisplay = typeof filter === "string" ? filter : String(filter);
  const desktopTimelineStyle = isMobile
    ? {
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "92vw",
      }
    : {
        left: sidebarCollapsed
          ? "50%"
          : `calc(50% + ${(SIDEBAR_LEFT_PX + SIDEBAR_WIDTH_PX) / 2}px)`,
        transform: "translateX(-50%)",
        maxWidth: sidebarCollapsed
          ? "min(92vw, 720px)"
          : `min(92vw, calc(100vw - ${SIDEBAR_WIDTH_PX + SIDEBAR_LEFT_PX * 2 + 24}px))`,
      };
  const mapViewPadding = useMemo<DatasetMapViewPadding>(
    () => [
      MAP_TOP_PADDING_PX,
      MAP_EDGE_PADDING_PX,
      MAP_BOTTOM_PADDING_PX,
      isMobile || sidebarCollapsed
        ? MAP_EDGE_PADDING_PX
        : SIDEBAR_LEFT_PX + SIDEBAR_WIDTH_PX + MAP_EDGE_PADDING_PX,
    ],
    [isMobile, sidebarCollapsed],
  );
  const sidebarContent = (
    <div
      className={`flex h-full flex-col pointer-events-auto ${!isMobile ? "rounded-2xl border border-gray-200/60 bg-white/95 px-4 pb-4 pt-4 shadow-xl backdrop-blur-sm" : "px-4 pt-4 pb-16"}`}
    >
      <div className="pb-3">
        <div className="flex flex-col">
          <div className="flex items-center">
            <h4 className="m-0 pr-2 font-medium text-gray-600">Images: </h4>
            <Tag className="m-0 font-semibold text-gray-700 bg-gray-100 border-gray-200">
              <span>{displayData?.length}</span>
            </Tag>
          </div>
          {filter && (
            <div className="flex items-center mt-2">
              <span className="text-xs text-gray-500 mr-2">Filtered by:</span>
              <Tag className="m-0 flex items-center gap-1" color="blue">
                <span className="text-xs font-medium">
                  {filterDisplay.slice(0, 15) +
                    (filterDisplay.length > 15 ? "..." : "")}
                </span>
                <Button
                  data-testid="dataset-active-filter-clear"
                  className="border-none bg-transparent h-auto p-0 ml-1 flex items-center justify-center text-blue-500 hover:text-blue-700"
                  size="small"
                  onClick={() => {
                    setFilter("");
                    setFilterTag("platform");
                  }}
                  icon={<CloseOutlined className="text-[10px]" />}
                />
              </Tag>
            </div>
          )}
        </div>
        {!isMobile && (
          <Button
            type="primary"
            icon={<UploadOutlined />}
            onClick={() =>
              runDesktopOnlyAction("upload", () => navigate("/profile"))
            }
            className="mt-4 w-full shadow-sm font-medium"
          >
            Upload Data
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 pb-4">
        <ArchiveSearch
          mode={search.mode}
          value={search.input}
          loading={semantic.loading}
          onChange={search.changeInput}
          onModeChange={search.changeMode}
          onSubmit={() => {
            if (search.mode !== "ai" || !search.input.trim()) return;
            semantic.run(search.input);
            track("dataset_semantic_search_used", {
              search_length: search.input.trim().length,
            });
          }}
        />
        {search.mode === "ai" && (
          <div
            className={`flex items-start gap-1.5 px-1 text-xs ${semantic.error ? "text-red-600" : "text-gray-500"}`}
            role="status"
          >
            {semantic.loading ? (
              <>
                <LoadingOutlined className="mt-0.5" />
                <span>Searching imagery…</span>
              </>
            ) : semantic.error ? (
              <>
                <ExclamationCircleOutlined className="mt-0.5" />
                <span>{semantic.error}</span>
              </>
            ) : semantic.query ? (
              <span>
                Ranked by “{semantic.query}” · {semantic.scores?.size ?? 0}{" "}
                {semantic.scores?.size === 1 ? "match" : "matches"}
              </span>
            ) : (
              <span>Describe what you want to find, then press Enter.</span>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Checkbox
            checked={filterByViewport}
            onChange={(e) => setFilterByViewport(e.target.checked)}
          >
            Filter list by map view
          </Checkbox>

          <div className="flex items-center gap-2 sm:pl-2">
            <Tooltip title="Open advanced filtering options">
              <Button
                aria-label="Advanced filters"
                icon={<FilterOutlined />}
                onClick={handleFilterButtonClick}
              />
            </Tooltip>
            <Tooltip
              title={`Sort by addition order ${sortDirection === "asc" ? "oldest first" : "newest first"}`}
            >
              <Button
                icon={
                  sortDirection === "asc" ? (
                    <ArrowDownOutlined />
                  ) : (
                    <ArrowUpOutlined />
                  )
                }
                onClick={toggleSort}
              />
            </Tooltip>
          </div>
        </div>
      </div>

      {displayData ? (
        <DataList
          data={displayData}
          hoveredItem={hoveredItem}
          setHoveredItem={setHoveredItem}
          visibleFeatures={visibleFeatures}
          onFilterClick={handleFilterClick}
          searchValue={activeTextSearch}
          filterByViewport={filterByViewport}
          scores={semantic.scores}
          semanticQuery={semantic.query}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-500">
          <Spin size="large" />
          <span>Loading data...</span>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-slate-50"
      data-testid="dataset-archive-page"
    >
      {/* Floating Sidebar */}
      <div
        className={`absolute left-4 top-24 bottom-6 z-10 hidden md:flex transition-all duration-300 ${
          sidebarCollapsed
            ? "w-0 -translate-x-full overflow-hidden opacity-0 pointer-events-none"
            : "w-[360px] translate-x-0 opacity-100"
        }`}
      >
        {sidebarContent}
      </div>

      {!isMobile && (
        <div
          className="absolute z-20 hidden md:block transition-all duration-300"
          style={{
            top: `${SIDEBAR_BUTTON_TOP_PX}px`,
            left: sidebarCollapsed
              ? `${SIDEBAR_LEFT_PX + 8}px`
              : `${SIDEBAR_LEFT_PX + SIDEBAR_WIDTH_PX - FLOAT_BUTTON_SIZE_PX / 2}px`,
          }}
        >
          <Button
            size="large"
            shape="circle"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            icon={
              sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
            }
            className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
            style={{
              width: FLOAT_BUTTON_SIZE_PX,
              minWidth: FLOAT_BUTTON_SIZE_PX,
              height: FLOAT_BUTTON_SIZE_PX,
            }}
          />
        </div>
      )}

      <div className="absolute left-2 top-20 z-20 flex items-center md:hidden">
        <Button
          icon={<UnorderedListOutlined />}
          className="shadow-sm"
          onClick={() => setIsMobileListOpen(true)}
        >
          Datasets & Filters
        </Button>
      </div>

      <Drawer
        title="Datasets and filters"
        placement="bottom"
        height="85vh"
        open={isMobileListOpen}
        onClose={() => setIsMobileListOpen(false)}
        className="md:hidden"
        styles={{ body: { padding: "0", overflowY: "hidden" } }}
      >
        <div className="h-full bg-slate-50">{sidebarContent}</div>
      </Drawer>

      {/* Full Map */}
      <div className="absolute inset-0 z-0">
        <div
          className="absolute bottom-2 z-10 transition-all duration-300"
          style={desktopTimelineStyle}
        >
          {periods.length > 0 && selectedPeriod && (
            <DatasetTimelineControl
              periods={periods}
              selectedPeriod={selectedPeriod}
              onPeriodChange={setSelectedPeriod}
              cumulativeCount={cumulativeCount}
              addedInQuarter={addedInQuarter}
            />
          )}
        </div>
        {!displayData ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-500">
            <Spin size="large" />
            <span>Loading map...</span>
          </div>
        ) : (
          // The map stays mounted through empty results: the list already
          // explains the empty state, and remounting OpenLayers would drop the
          // viewport the visitor just set up.
          <DatasetMapOL
            data={displayData}
            hoveredItem={hoveredItem}
            setHoveredItem={setHoveredItem}
            setVisibleFeatures={setVisibleFeatures}
            filterZoomTrigger={filterZoomTrigger}
            colorMode={colorMode}
            onMapInteracted={handleMapInteracted}
            viewPadding={mapViewPadding}
            // On tall phone screens, framing the whole world leaves empty bands
            // above and below it, so phones keep the default zoom.
            frameDataOnOpen={!isMobile}
          />
        )}
      </div>

      {/* Filter Modal */}
      <FilterModal
        isVisible={isFilterModalVisible}
        onClose={() => {
          setIsFilterModalVisible(false);
          if (isMobile) setIsMobileListOpen(true);
        }}
        onApplyFilters={handleApplyFilters}
        currentFilters={advancedFilters}
      />
    </div>
  );
}
