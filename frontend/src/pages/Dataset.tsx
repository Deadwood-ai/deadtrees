import { useMemo, useState, useEffect } from "react";
import { Button, Tag, Input, Spin, Tooltip, Checkbox, Drawer } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  FilterOutlined,
  CloseOutlined,
  UploadOutlined,
  UnorderedListOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";

import DataList from "../components/DataList";
import DatasetMapOL, { type DatasetMapColorMode } from "../components/DatasetMap/DatasetMap";
import DatasetTimelineControl from "../components/DatasetMap/DatasetTimelineControl";
import { useNavigate } from "react-router-dom";
import { useFilteredDatasets } from "../hooks/useFilteredDatasets";
import { usePublicDatasets } from "../hooks/useDatasets";
import { useUploadTimeline } from "../hooks/useUploadTimeline";
import FilterModal, { AdvancedFilters } from "../components/FilterModal";
import { useDatasetFilter } from "../hooks/useDatasetFilterProvider";
import { isDatasetViewable } from "../utils/datasetVisibility";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDesktopOnlyFeature } from "../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../hooks/useAnalytics";

type FilterTag = "platform" | "license" | "authors_image" | "admin_level_1" | "admin_level_3" | "biome";

const SIDEBAR_LEFT_PX = 16;
const SIDEBAR_WIDTH_PX = 360;
const SIDEBAR_BUTTON_TOP_PX = 108;
const FLOAT_BUTTON_SIZE_PX = 36;

export default function Dataset() {
  const navigate = useNavigate();
  const { data: allData } = usePublicDatasets();
  const { filteredData } = useFilteredDatasets(allData);

  // Get filter state from context
  const {
    filter,
    setFilter,
    setFilterTag,
    advancedFilters,
    setAdvancedFilters,
    searchInput,
    setSearchInput,
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

  // Debounced search handler
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchValue(searchInput.toLowerCase());
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

  const handleSearch = (value: string) => {
    setSearchInput(value);
  };

  const toggleSort = () => {
    setSortDirection(sortDirection === "asc" ? "desc" : "asc");
  };

  const handleFilterClick = (filterValue: string, filterType: FilterTag) => {
    setFilter(filterValue);
    setFilterTag(filterType);
    setFilterZoomTrigger((n) => n + 1);
    track("dataset_filter_applied", {
      filter_type: filterType,
      filter_value: filterValue,
    });
  };

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

  const processedData = useMemo(() => {
    if (!filteredData) return null;

    const filtered = filteredData.filter((d) => {
      // Use centralized visibility check
      if (!isDatasetViewable(d)) return false;

      // If no search value, return true for the base condition
      if (!searchValue.trim()) return true;

      const searchTerms = searchValue.toLowerCase().split(/\s+/).filter(Boolean);

      // Search in authors
      const authorMatch =
        d.authors?.some((author) => searchTerms.every((term) => author.toLowerCase().includes(term))) || false;

      // Search in location - now including admin_level_2
      const locationWords = `${d.admin_level_3 || ""}, ${d.admin_level_2 || ""}, ${d.admin_level_1 || ""}`
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);

      const locationMatch = searchTerms.every((term) => locationWords.some((word) => word.includes(term)));

      return authorMatch || locationMatch;
    });

    // Sort by ID instead of date (ID represents order of addition to database)
    return filtered.sort((a, b) => {
      return sortDirection === "asc" ? a.id - b.id : b.id - a.id;
    });
  }, [filteredData, searchValue, sortDirection]);

  const { periods, selectedPeriod, setSelectedPeriod, displayData, cumulativeCount, addedInQuarter } =
    useUploadTimeline(processedData);

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
  const sidebarContent = (
    <div className={`flex h-full flex-col pointer-events-auto ${!isMobile ? "rounded-2xl border border-gray-200/60 bg-white/95 px-4 pb-4 pt-4 shadow-xl backdrop-blur-sm" : "px-4 pt-4 pb-16"}`}>
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
                  {filterDisplay.slice(0, 15) + (filterDisplay.length > 15 ? "..." : "")}
                </span>
                <Button
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
            onClick={() => runDesktopOnlyAction("upload", () => navigate("/profile"))}
            className="mt-4 w-full shadow-sm font-medium"
          >
            Upload Data
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Search by Authors or Location (Region, Province, City)"
            onChange={(e) => handleSearch(e.target.value)}
            className="flex-1"
            allowClear
            value={searchInput}
          />
          <div className="flex items-center gap-2 sm:pl-2">
            <Tooltip title="Open advanced filtering options">
              <Button icon={<FilterOutlined />} onClick={handleFilterButtonClick} />
            </Tooltip>
            <Tooltip title={`Sort by addition order ${sortDirection === "asc" ? "oldest first" : "newest first"}`}>
              <Button icon={sortDirection === "asc" ? <ArrowDownOutlined /> : <ArrowUpOutlined />} onClick={toggleSort} />
            </Tooltip>
          </div>
        </div>
        <div className="ml-1 mt-0">
          <Checkbox checked={filterByViewport} onChange={(e) => setFilterByViewport(e.target.checked)}>
            Filter list by map view
          </Checkbox>
        </div>
      </div>

      {displayData ? (
        <DataList
          data={displayData}
          hoveredItem={hoveredItem}
          setHoveredItem={setHoveredItem}
          visibleFeatures={visibleFeatures}
          onFilterClick={handleFilterClick}
          searchValue={searchValue}
          filterByViewport={filterByViewport}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spin size="large" tip="Loading data..." />
        </div>
      )}
    </div>
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-50">
      {/* Floating Sidebar */}
      <div
        className={`absolute left-4 top-24 bottom-6 z-10 hidden md:flex transition-all duration-300 ${sidebarCollapsed
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
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            className="bg-white shadow-md border-gray-200 text-gray-700 hover:text-gray-900"
            style={{ width: FLOAT_BUTTON_SIZE_PX, minWidth: FLOAT_BUTTON_SIZE_PX, height: FLOAT_BUTTON_SIZE_PX }}
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
        styles={{ body: { padding: '0', overflowY: 'hidden' } }}
      >
        <div className="h-full bg-slate-50">{sidebarContent}</div>
      </Drawer>

      {/* Full Map */}
      <div className="absolute inset-0 z-0">
        <div className="absolute bottom-2 z-10 transition-all duration-300" style={desktopTimelineStyle}>
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
          <div className="flex h-full items-center justify-center">
            <Spin size="large" tip="Loading map..." />
          </div>
        ) : displayData.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-lg bg-white">
            <div className="text-lg font-medium text-gray-500">No results found</div>
            <div className="text-sm text-gray-400">Try adjusting your filters or search criteria</div>
          </div>
        ) : (
          <DatasetMapOL
            data={displayData}
            hoveredItem={hoveredItem}
            setHoveredItem={setHoveredItem}
            setVisibleFeatures={setVisibleFeatures}
            filterZoomTrigger={filterZoomTrigger}
            colorMode={colorMode}
            onMapInteracted={() =>
              track("dataset_map_interacted", {
                interaction_type: "move",
              })
            }
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
