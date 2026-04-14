import { useEffect, useMemo } from "react";
import { Segmented, Tooltip, Typography, Spin, Button, Select } from "antd";
import {
  LeftOutlined,
  RightOutlined,
  LoadingOutlined,
  CameraOutlined,
  LinkOutlined,
  InfoCircleOutlined,
  WarningOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import type { WaybackItemWithMetadata } from "../../hooks/useWaybackItems";

const { Text } = Typography;

const PREDICTION_YEARS = ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"];

/**
 * Format date for display (e.g., "Jun 15, 2022")
 */
const formatDate = (date: Date | undefined): string => {
  if (!date) return "Unknown";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

/**
 * Format resolution for display
 */
const formatResolution = (resolution: number | undefined): string => {
  if (!resolution) return "";
  if (resolution < 1) {
    return `${Math.round(resolution * 100)}cm`;
  }
  return `${resolution}m`;
};

/**
 * Find the closest imagery to a target year, preferring older over newer
 */
const findClosestImagery = (items: WaybackItemWithMetadata[], targetYear: number): WaybackItemWithMetadata | null => {
  if (items.length === 0) return null;

  return items.reduce((closest, item) => {
    const itemYear = item.acquisitionDate?.getFullYear() || 0;
    const closestYear = closest.acquisitionDate?.getFullYear() || 0;

    const itemDiff = itemYear - targetYear;
    const closestDiff = closestYear - targetYear;

    // Prefer exact match
    if (itemDiff === 0) return item;
    if (closestDiff === 0) return closest;

    // Prefer older (negative diff) over newer (positive diff)
    if (itemDiff <= 0 && closestDiff > 0) return item;
    if (itemDiff > 0 && closestDiff <= 0) return closest;

    // If both older or both newer, prefer closer
    return Math.abs(itemDiff) < Math.abs(closestDiff) ? item : closest;
  });
};

interface YearImagerySelectorProps {
  /** Currently selected prediction year */
  predictionYear: string;
  /** Callback when prediction year changes */
  onPredictionYearChange: (year: string) => void;
  /** Currently selected imagery release number */
  selectedReleaseNum: number | null;
  /** Callback when imagery selection changes */
  onImageryChange: (releaseNum: number) => void;
  /** All available wayback items with metadata (already sorted by acquisition date) */
  waybackItems: WaybackItemWithMetadata[];
  /** Whether wayback data is loading */
  isLoading?: boolean;
  /** Whether satellite basemap is active */
  isWaybackActive?: boolean;
  /** Whether to auto-match imagery to prediction year */
  autoMatchImagery?: boolean;
  /** Callback when auto-match setting changes */
  onAutoMatchChange?: (enabled: boolean) => void;
  /** Whether tree cover layer is shown */
  showForest?: boolean;
  /** Whether standing deadwood layer is shown */
  showDeadwood?: boolean;
  /** Compact mobile layout mode */
  compactMode?: boolean;
}

/**
 * Year and imagery selector.
 * - Top row: Prediction year selector (for deadwood predictions)
 * - Bottom row: Satellite imagery navigation with metadata display
 *
 * Items are already unique (from getWaybackItemsWithLocalChanges) and
 * sorted by acquisition date ascending (oldest left, newest right).
 * Navigation: ← older, → newer
 */
const YearImagerySelector = ({
  predictionYear,
  onPredictionYearChange,
  selectedReleaseNum,
  onImageryChange,
  waybackItems,
  isLoading = false,
  isWaybackActive = true,
  autoMatchImagery = true,
  onAutoMatchChange,
  showForest = false,
  showDeadwood = false,
  compactMode = false,
}: YearImagerySelectorProps) => {
  // Determine the active product name based on which layers are shown
  const activeProductName =
    showForest && showDeadwood
      ? "Fractional Cover"
      : showForest
        ? "Fractional Tree Cover"
        : showDeadwood
          ? "Fractional Standing Deadwood"
          : "Predictions";

  // Items are already sorted by acquisition date (oldest first) from the hook

  // Extract years that have imagery from waybackItems
  const yearsWithImagery = useMemo(() => {
    const years = new Set<string>();
    waybackItems.forEach((item) => {
      const year = item.acquisitionDate?.getFullYear().toString();
      if (year) years.add(year);
    });
    return years;
  }, [waybackItems]);

  // Dynamic options with visual indicator for years with imagery (no opacity - all years have predictions)
  const predictionYearOptions = useMemo(
    () =>
      PREDICTION_YEARS.map((y) => ({
        value: y,
        label: (
          <span className="inline-flex items-center">
            {y}
            {yearsWithImagery.has(y) && (
              <span className="ml-0.5 text-green-500" style={{ fontSize: "18px", lineHeight: 0 }}>
                •
              </span>
            )}
          </span>
        ),
      })),
    [yearsWithImagery],
  );

  // Check if current selection is valid (exists in current waybackItems)
  const isSelectionValid =
    selectedReleaseNum !== null && waybackItems.some((item) => item.releaseNum === selectedReleaseNum);

  // Auto-select imagery when items load or when current selection becomes invalid
  useEffect(() => {
    if (waybackItems.length > 0 && (!selectedReleaseNum || !isSelectionValid)) {
      if (autoMatchImagery) {
        const targetYear = parseInt(predictionYear);
        const closestItem = findClosestImagery(waybackItems, targetYear);
        if (closestItem) {
          onImageryChange(closestItem.releaseNum);
        }
      } else {
        // Select the newest (rightmost) item
        onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
      }
    }
  }, [waybackItems, selectedReleaseNum, isSelectionValid, onImageryChange, autoMatchImagery, predictionYear]);

  // Auto-match imagery when prediction year changes (if enabled)
  useEffect(() => {
    if (!autoMatchImagery || waybackItems.length === 0 || !selectedReleaseNum) return;

    const targetYear = parseInt(predictionYear);
    const closestItem = findClosestImagery(waybackItems, targetYear);
    if (closestItem && closestItem.releaseNum !== selectedReleaseNum) {
      onImageryChange(closestItem.releaseNum);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictionYear, autoMatchImagery]); // Only trigger on year change or toggle change

  // Navigation for prediction year
  const predictionIndex = PREDICTION_YEARS.indexOf(predictionYear);
  const isPredictionFirst = predictionIndex === 0;
  const isPredictionLast = predictionIndex === PREDICTION_YEARS.length - 1;

  const handlePredictionPrev = () => {
    if (!isPredictionFirst) {
      onPredictionYearChange(PREDICTION_YEARS[predictionIndex - 1]);
    }
  };

  const handlePredictionNext = () => {
    if (!isPredictionLast) {
      onPredictionYearChange(PREDICTION_YEARS[predictionIndex + 1]);
    }
  };

  // Find currently selected item
  const currentImageryIndex = waybackItems.findIndex((item) => item.releaseNum === selectedReleaseNum);
  const selectedItem = currentImageryIndex >= 0 ? waybackItems[currentImageryIndex] : null;
  const hasMultipleImages = waybackItems.length > 1;
  const isImageryFirst = currentImageryIndex <= 0;
  const isImageryLast = currentImageryIndex >= waybackItems.length - 1;

  // Navigation: ← goes to older (lower index), → goes to newer (higher index)
  const handleImageryPrev = () => {
    if (!isImageryFirst && waybackItems[currentImageryIndex - 1]) {
      onImageryChange(waybackItems[currentImageryIndex - 1].releaseNum);
    }
  };

  const handleImageryNext = () => {
    if (!isImageryLast && waybackItems[currentImageryIndex + 1]) {
      onImageryChange(waybackItems[currentImageryIndex + 1].releaseNum);
    }
  };

  const hasNoImagery = waybackItems.length === 0 && !isLoading;

  // Get the base map year for display
  const baseMapYear = selectedItem?.acquisitionDate?.getFullYear();
  const yearsMatch = baseMapYear?.toString() === predictionYear;
  const compactTopButtonClass =
    "flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300";
  const compactBottomButtonClass =
    "flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-200";

  return (
    <div className="pointer-events-auto flex w-[calc(100vw-1rem)] max-w-[min(42rem,calc(100vw-1rem))] flex-col items-center gap-1 overflow-hidden rounded-xl border border-gray-200/60 bg-white/95 px-2 py-2 shadow-xl backdrop-blur-sm md:gap-2 md:w-auto md:max-w-none md:rounded-2xl md:px-4 md:py-3">
      {/* Row 1: Prediction Year with label on top */}
      <div className="flex w-full flex-col items-center gap-1">
        <div className="flex w-full items-center justify-center gap-2 overflow-x-auto">
          <button
            onClick={handlePredictionPrev}
            disabled={isPredictionFirst}
            className={compactTopButtonClass}
          >
            <LeftOutlined />
          </button>
          {compactMode ? (
            <Select
              size="small"
              value={predictionYear}
              onChange={(value) => onPredictionYearChange(value)}
              options={PREDICTION_YEARS.map((year) => ({ value: year, label: year }))}
              className="min-w-24"
            />
          ) : (
            <Segmented
              size="small"
              value={predictionYear}
              onChange={(value) => onPredictionYearChange(value as string)}
              options={predictionYearOptions}
            />
          )}
          <button
            onClick={handlePredictionNext}
            disabled={isPredictionLast}
            className={compactTopButtonClass}
          >
            <RightOutlined />
          </button>

          {/* Auto-match toggle */}
          {isWaybackActive && (
            <Tooltip title={autoMatchImagery ? "Auto-matching imagery to year" : "Manual imagery selection"}>
              <Button
                size="small"
                type={autoMatchImagery ? "primary" : "default"}
                icon={<LinkOutlined />}
                onClick={() => onAutoMatchChange?.(!autoMatchImagery)}
                className="ml-1"
              />
            </Tooltip>
          )}
        </div>
      </div>

      {/* Row 2: Base Layer with label and informative message */}
      {isWaybackActive && (
        <div className="flex w-full flex-col items-center gap-1 border-t border-gray-100 pt-2">
          {/* Informative message - always visible when imagery is loaded */}
          {!isLoading && waybackItems.length > 0 && selectedItem && !compactMode && (
            <div className="flex items-center gap-1.5 text-xs">
              {yearsMatch ? (
                <CheckCircleOutlined className="text-green-500" style={{ fontSize: "12px" }} />
              ) : (
                <WarningOutlined className="text-amber-500" style={{ fontSize: "12px" }} />
              )}
              <Text type="secondary">
                {yearsMatch ? (
                  <>
                    {predictionYear} {activeProductName} with matching{" "}
                    <span className="text-green-500" style={{ fontSize: "14px", lineHeight: 0 }}>
                      •
                    </span>{" "}
                    base map
                  </>
                ) : (
                  <>
                    {compactMode
                      ? `${predictionYear} vs ${baseMapYear || "unknown"} base map`
                      : `${predictionYear} ${activeProductName} against ${baseMapYear || "unknown"} base map`}
                  </>
                )}
              </Text>
            </div>
          )}

          <div className="flex w-full items-center justify-center gap-2 overflow-x-auto">
            {isLoading ? (
              <div className="flex items-center gap-2 text-gray-400">
                <Spin indicator={<LoadingOutlined style={{ fontSize: 14 }} spin />} />
                <span className="text-xs">Finding basemap imagery for this area ...</span>
              </div>
            ) : hasNoImagery ? (
              <Text type="secondary" className="text-xs text-gray-400">
                No satellite imagery available at this location
              </Text>
            ) : (
              <>
                {/* Navigation arrow: ← older */}
                {hasMultipleImages && (
                  <button
                    onClick={handleImageryPrev}
                    disabled={isImageryFirst}
                    className={compactBottomButtonClass}
                    title="Older imagery"
                  >
                    <LeftOutlined style={{ fontSize: "10px" }} />
                  </button>
                )}

                {/* Imagery info from item metadata */}
                <div className="flex items-center gap-2">
                  <CameraOutlined className="text-gray-400" style={{ fontSize: "12px" }} />

                  {selectedItem ? (
                    <Tooltip
                      title={
                        <div className="text-center">
                          <div className="font-medium">Satellite Imagery</div>
                          <div className="mt-1">Captured: {formatDate(selectedItem.acquisitionDate)}</div>
                          {selectedItem.provider && <div>Provider: {selectedItem.provider}</div>}
                          {selectedItem.source && <div>Satellite: {selectedItem.source}</div>}
                          {selectedItem.resolution && (
                            <div>Resolution: {formatResolution(selectedItem.resolution)}</div>
                          )}
                          {hasMultipleImages && (
                            <div className="mt-1 text-gray-300">
                              Image {currentImageryIndex + 1} of {waybackItems.length}
                            </div>
                          )}
                        </div>
                      }
                      placement="top"
                    >
                      <div className="flex cursor-help items-center gap-1.5 text-xs">
                        <span className="font-medium text-gray-700">{formatDate(selectedItem.acquisitionDate)}</span>
                        {!compactMode && selectedItem.provider && <span className="text-gray-400">·</span>}
                        {!compactMode && selectedItem.provider && <span className="text-gray-500">{selectedItem.provider}</span>}
                        {!compactMode && selectedItem.source && <span className="text-gray-400">{selectedItem.source}</span>}
                        {!compactMode && selectedItem.resolution && (
                          <>
                            <span className="text-gray-400">·</span>
                            <span className="text-gray-500">{formatResolution(selectedItem.resolution)}</span>
                          </>
                        )}
                      </div>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-gray-400">No imagery selected</span>
                  )}
                </div>

                {/* Navigation arrow: → newer */}
                {hasMultipleImages && (
                  <button
                    onClick={handleImageryNext}
                    disabled={isImageryLast}
                    className={compactBottomButtonClass}
                    title="Newer imagery"
                  >
                    <RightOutlined style={{ fontSize: "10px" }} />
                  </button>
                )}

                {/* Info icon at bottom right */}
                <Tooltip
                  title={
                    <div className="text-center">
                      <div className="font-medium">About this view</div>
                      <div className="mt-1">Predictions are available for all years (2017-2025).</div>
                      <div className="mt-1">
                        <span className="text-green-400">•</span> indicates base map imagery is available for that year.
                      </div>
                      <div className="mt-1 text-gray-300">
                        The base map shows satellite imagery for visual context only.
                      </div>
                    </div>
                  }
                >
                  <InfoCircleOutlined className="ml-1 cursor-help text-gray-400" style={{ fontSize: "12px" }} />
                </Tooltip>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default YearImagerySelector;
