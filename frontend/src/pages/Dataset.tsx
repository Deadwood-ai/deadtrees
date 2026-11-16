import { useMemo, useState, useEffect, useCallback, type ReactNode } from "react";
import { Badge, Button, Tag, Tooltip, Drawer } from "antd";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  EyeOutlined,
  FilterOutlined,
  UploadOutlined,
  UnorderedListOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";

import DataList from "../components/DataList";
import { ListSkeleton, SectionLoadError } from "../components/SectionStates";
import { MapSkeleton } from "../components/PageSkeletons";
import DatasetMapOL, {
  type DatasetMapColorMode,
  type DatasetMapViewPadding,
} from "../components/DatasetMap/DatasetMap";
import DatasetTimelineControl from "../components/DatasetMap/DatasetTimelineControl";
import { useNavigate } from "react-router-dom";
import { useArchiveSearchInfo, usePublicDatasetArchiveItems } from "../hooks/useDatasets";
import { useUploadTimeline } from "../hooks/useUploadTimeline";
import FilterModal from "../components/FilterModal";
import ActiveFilterChips from "../components/DatasetMap/ActiveFilterChips";
import { useDatasetFilter } from "../hooks/useDatasetFilterProvider";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDesktopOnlyFeature } from "../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../hooks/useAnalytics";
import { useArchiveSearch } from "../hooks/useArchiveSearch";
import ArchiveSearch from "../components/DatasetMap/ArchiveSearch";
import { createDatasetArchiveTextMatcher, createInfoSnippetFinder } from "../utils/archiveTextSearch";
import {
  EMPTY_ARCHIVE_FILTERS,
  createArchiveFilter,
  describeActiveFilters,
  toggleChipFilter,
  type ArchiveChipFilter,
  type ArchiveFilters,
} from "../utils/datasetArchiveFilters";

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
  const {
    data: allData,
    isError: archiveFailed,
    refetch: retryArchive,
  } = usePublicDatasetArchiveItems();

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

  const {
    filters,
    setFilters,
    sortDirection,
    setSortDirection,
    filterByViewport,
    setFilterByViewport,
  } = useDatasetFilter();

  const [hoveredItem, setHoveredItem] = useState<number | null>(null);
  const [visibleFeatures, setVisibleFeatures] = useState<string[]>([]);
  const [isFilterModalVisible, setIsFilterModalVisible] = useState(false);
  const [isMobileListOpen, setIsMobileListOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const colorMode: DatasetMapColorMode = "timeline";
  const isMobile = useIsMobile();
  const { runDesktopOnlyAction } = useDesktopOnlyFeature();
  const { track } = useAnalytics("dataset_archive");
  // Incremented to frame the current results on the map.
  const [filterZoomTrigger, setFilterZoomTrigger] = useState(0);
  const zoomToMatches = useCallback(() => setFilterZoomTrigger((n) => n + 1), []);

  // Open-vocabulary (CLIP) search is public; the ranking RPC only returns
  // datasets visible to the caller.
  const search = useArchiveSearch();
  const { semantic } = search;
  // The committed text query: it trails the search field by a short debounce,
  // so the list and map are not re-filtered on every keystroke.
  const activeTextSearch = search.text;
  const { data: info } = useArchiveSearchInfo(!!activeTextSearch.trim());
  // Cards whose additional information matched the search show the matched text.
  const findInfoSnippet = useMemo(
    () => (activeTextSearch.trim() && info ? createInfoSnippetFinder(activeTextSearch, info) : undefined),
    [activeTextSearch, info],
  );

  useEffect(() => {
    track("dataset_archive_viewed", {});
  }, [track]);

  useEffect(() => {
    if (!activeTextSearch.trim()) return;
    track("dataset_search_used", {
      search_length: activeTextSearch.trim().length,
    });
  }, [activeTextSearch, track]);

  const toggleSort = () => {
    setSortDirection(sortDirection === "asc" ? "desc" : "asc");
  };

  // A filter change frames the new results on the map, unless the list follows
  // the map view: then the visitor's region is the point and the map stays put.
  const changeFilters = useCallback(
    (next: ArchiveFilters) => {
      setFilters(next);
      if (!filterByViewport) zoomToMatches();
    },
    [setFilters, filterByViewport, zoomToMatches],
  );

  // Stable identity keeps the memoised DataList/DatasetMapOL from re-rendering on
  // every keystroke in the search box.
  const handleFilterClick = useCallback(
    (key: ArchiveChipFilter, value: string) => {
      changeFilters(toggleChipFilter(filters, key, value));
      track("dataset_filter_applied", { filter_type: key, filter_value: value });
    },
    [changeFilters, filters, track],
  );

  const handleMapInteracted = useCallback(() => {
    track("dataset_map_interacted", { interaction_type: "move" });
  }, [track]);

  const handleFilterButtonClick = () => {
    setIsFilterModalVisible(true);
  };

  const activeFilters = useMemo(() => describeActiveFilters(filters), [filters]);

  const handleApplyFilters = (next: ArchiveFilters) => {
    changeFilters(next);
    const applied = describeActiveFilters(next);
    track("dataset_filter_applied", {
      filter_type: [...new Set(applied.map((chip) => chip.id.split(":")[0]))].join(",") || "none",
      filter_value: String(applied.length),
    });
  };

  // Filters, text/semantic search and sorting apply on top of the timeline
  // slice, so they affect only which datasets are shown — never the timeline.
  const displayData = useMemo(() => {
    if (!timeFilteredData) return null;

    const matchesFilters = createArchiveFilter(filters);
    const matchesText = createDatasetArchiveTextMatcher(activeTextSearch, info);
    const filtered = timeFilteredData.filter(
      (item) => matchesFilters(item) && matchesText(item),
    );

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
  }, [timeFilteredData, filters, activeTextSearch, info, sortDirection, semantic.scores]);
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
          <ActiveFilterChips
            chips={activeFilters}
            onRemove={(chip) => changeFilters(chip.clear(filters))}
            onClearAll={() => changeFilters(EMPTY_ARCHIVE_FILTERS)}
          />
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
        <div className="flex items-center justify-end gap-2">
          <Tooltip
            title={
              filterByViewport
                ? "Only images in the current map view are listed. Click to list every match."
                : "Every match is listed. Click to list only images in the current map view."
            }
          >
            <Button
              aria-label="Only list images in the map view"
              aria-pressed={filterByViewport}
              data-testid="dataset-map-view-filter"
              type={filterByViewport ? "primary" : "default"}
              icon={<EyeOutlined />}
              onClick={() => setFilterByViewport(!filterByViewport)}
            />
          </Tooltip>
          <Tooltip title="Filter by author, country, season, resolution and more">
            <Badge count={activeFilters.length} size="small" color="#1B5E35">
              <Button
                aria-label="Filters"
                icon={<FilterOutlined />}
                onClick={handleFilterButtonClick}
              />
            </Badge>
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

      {displayData ? (
        <DataList
          data={displayData}
          hoveredItem={hoveredItem}
          setHoveredItem={setHoveredItem}
          visibleFeatures={visibleFeatures}
          onFilterClick={handleFilterClick}
          filterByViewport={filterByViewport}
          onZoomToMatches={zoomToMatches}
          findInfoSnippet={findInfoSnippet}
          scores={semantic.scores}
          semanticQuery={semantic.query}
        />
      ) : (
        <ArchivePlaceholder
          failed={archiveFailed}
          onRetry={() => void retryArchive()}
          loading={<ListSkeleton label="Loading datasets" />}
        />
      )}
    </div>
  );

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-slate-50"
      data-testid="dataset-archive-page"
    >
      <h1 className="sr-only">Drone orthophoto archive of forests worldwide</h1>
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
          // On desktop the list beside the map already explains a failure.
          <ArchivePlaceholder
            failed={archiveFailed && isMobile}
            onRetry={() => void retryArchive()}
            loading={archiveFailed ? null : <MapSkeleton label="Loading map" />}
          />
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
        filters={filters}
        onChange={handleApplyFilters}
        data={timeFilteredData ?? []}
      />
    </div>
  );
}

// Until the archive arrives, list and map show a wait or a failure.
function ArchivePlaceholder({
  failed,
  onRetry,
  loading,
}: {
  failed: boolean;
  onRetry: () => void;
  loading: ReactNode;
}) {
  if (!failed) return <>{loading}</>;
  return (
    <div className="flex h-full flex-col justify-center p-4" role="alert">
      <SectionLoadError title="The drone archive couldn’t load" onRetry={onRetry} />
    </div>
  );
}
