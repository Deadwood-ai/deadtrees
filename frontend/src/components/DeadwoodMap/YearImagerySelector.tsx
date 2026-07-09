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
import {
  resolveWaybackCandidate,
  type WaybackItemWithMetadata,
  type WaybackLoadProgress,
} from "../../hooks/useWaybackItems";

const { Text } = Typography;

export const PREDICTION_YEARS = [
  "2017",
  "2018",
  "2019",
  "2020",
  "2021",
  "2022",
  "2023",
  "2024",
  "2025",
];

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

export const getImageryDate = (
  item: WaybackItemWithMetadata | null | undefined,
): Date | undefined => {
  if (!item) return undefined;
  if (item.acquisitionDate) return item.acquisitionDate;
  if (item.releaseDatetime) return new Date(item.releaseDatetime);
  if (item.releaseDateLabel) return new Date(item.releaseDateLabel);
  return undefined;
};

const getImageryYear = (item: WaybackItemWithMetadata): number | undefined =>
  getImageryDate(item)?.getFullYear();

/**
 * Years for which imagery is verified to exist at this location.
 *
 * Only counts acquisition dates from ESRI's metadata service — never the
 * release-date fallback. Release dates say when ESRI published a snapshot,
 * not when the local imagery was captured, so a dot derived from them can
 * "move" to a different year the moment the item's metadata resolves. Verified
 * years are sticky: dots can only appear as knowledge grows, never jump.
 */
export const getVerifiedImageryYears = (
  items: WaybackItemWithMetadata[],
): Set<string> => {
  const years = new Set<string>();
  items.forEach((item) => {
    const year = item.acquisitionDate?.getFullYear();
    if (year !== undefined) years.add(year.toString());
  });
  return years;
};

/**
 * Find the closest imagery to a target year, preferring older over newer
 */
export const findClosestImagery = (
  items: WaybackItemWithMetadata[],
  targetYear: number,
): WaybackItemWithMetadata | null => {
  if (items.length === 0) return null;

  return items.reduce((closest, item) => {
    const itemYear = getImageryYear(item) || 0;
    const closestYear = getImageryYear(closest) || 0;

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

/**
 * Decide whether auto-match should switch to a different imagery release.
 * Returns the release number to switch to, or null to keep the selection.
 *
 * The selection is resolved to the candidate whose imagery it actually shows
 * (releases between two local changes serve identical tiles). Auto-match
 * stays put when the selection already shows the best candidate's imagery, or
 * imagery from the same year — switching would reload the basemap without a
 * visible benefit.
 */
export const pickAutoMatchImagery = (
  items: WaybackItemWithMetadata[],
  targetYear: number,
  selectedReleaseNum: number | null,
): number | null => {
  const closest = findClosestImagery(items, targetYear);
  if (!closest || closest.releaseNum === selectedReleaseNum) return null;

  const current = resolveWaybackCandidate(items, selectedReleaseNum);
  if (current) {
    if (current.releaseNum === closest.releaseNum) return null;
    if (getImageryYear(current) === getImageryYear(closest)) return null;
  }

  return closest.releaseNum;
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
  /** Pipeline progress while imagery history loads */
  loadProgress?: WaybackLoadProgress | null;
  /** Dates in waybackItems are unverified release dates (discovery failed) */
  isUnverifiedFallback?: boolean;
  /** Whether satellite basemap is active */
  isWaybackActive?: boolean;
  /** Whether to auto-match imagery to prediction year */
  autoMatchImagery?: boolean;
  /** Callback when auto-match setting changes */
  onAutoMatchChange?: (enabled: boolean) => void;
  /** Callback when the user asks for local imagery candidates */
  onRequestLocalImagery?: () => void;
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
  loadProgress = null,
  isUnverifiedFallback = false,
  isWaybackActive = true,
  autoMatchImagery = false,
  onAutoMatchChange,
  onRequestLocalImagery,
  showForest = false,
  showDeadwood = false,
  compactMode = false,
}: YearImagerySelectorProps) => {
  // Determine the active product name based on which layers are shown
  const activeProductName =
    showForest && showDeadwood
      ? "Fractional cover [%]"
      : showForest
        ? "Tree cover [%]"
        : showDeadwood
          ? "Deadwood cover [%]"
          : "Predictions";

  // Items are already sorted by acquisition date (oldest first) from the hook

  // Years with verified (acquisition-dated) imagery at this location. Never
  // derived from release dates, so the dots stay put while metadata streams in.
  const yearsWithImagery = useMemo(
    () => getVerifiedImageryYears(waybackItems),
    [waybackItems],
  );

  // Dynamic options with visual indicator for years with imagery (no opacity - all years have predictions)
  const predictionYearOptions = useMemo(
    () =>
      PREDICTION_YEARS.map((y) => ({
        value: y,
        label: (
          <span className="inline-flex items-center">
            {y}
            {yearsWithImagery.has(y) && (
              <span
                className="ml-0.5 text-green-500"
                style={{ fontSize: "18px", lineHeight: 0 }}
              >
                •
              </span>
            )}
          </span>
        ),
      })),
    [yearsWithImagery],
  );

  // Auto-select imagery when items load, when the prediction year changes, or
  // when no basemap has been selected yet. Manual mode keeps the active
  // basemap sticky even if it is outside the local candidate list.
  useEffect(() => {
    if (waybackItems.length === 0) return;

    if (autoMatchImagery) {
      const nextReleaseNum = pickAutoMatchImagery(
        waybackItems,
        parseInt(predictionYear),
        selectedReleaseNum,
      );
      if (nextReleaseNum !== null) {
        onImageryChange(nextReleaseNum);
      }
      return;
    }

    if (!selectedReleaseNum) {
      // Select the newest (rightmost) item
      onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
    }
  }, [
    waybackItems,
    selectedReleaseNum,
    onImageryChange,
    autoMatchImagery,
    predictionYear,
  ]);

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

  // Resolve the selection to the candidate whose imagery it actually shows:
  // releases between two local changes serve identical tiles, so a selected
  // release that is not itself a candidate still displays a candidate's image.
  const selectedItem = resolveWaybackCandidate(
    waybackItems,
    selectedReleaseNum,
  );
  const currentImageryIndex = selectedItem
    ? waybackItems.indexOf(selectedItem)
    : -1;
  const hasSelectedBasemap = selectedReleaseNum !== null;
  const isUsingDefaultBasemap = hasSelectedBasemap && !selectedItem;
  const hasMultipleImages = waybackItems.length > 1;
  const canNavigateImagery =
    waybackItems.length > 0 && (hasMultipleImages || currentImageryIndex < 0);
  const isSelectionOutsideCandidates = currentImageryIndex < 0;
  const isImageryFirst =
    waybackItems.length === 0 ||
    (!isSelectionOutsideCandidates && currentImageryIndex <= 0);
  const isImageryLast =
    waybackItems.length === 0 ||
    (!isSelectionOutsideCandidates &&
      currentImageryIndex >= waybackItems.length - 1);

  // Navigation: ← goes to older (lower index), → goes to newer (higher index)
  const handleImageryPrev = () => {
    onRequestLocalImagery?.();

    if (isSelectionOutsideCandidates && waybackItems.length > 0) {
      if (autoMatchImagery) onAutoMatchChange?.(false);
      onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
      return;
    }

    if (!isImageryFirst && waybackItems[currentImageryIndex - 1]) {
      if (autoMatchImagery) onAutoMatchChange?.(false);
      onImageryChange(waybackItems[currentImageryIndex - 1].releaseNum);
    }
  };

  const handleImageryNext = () => {
    onRequestLocalImagery?.();

    if (isSelectionOutsideCandidates && waybackItems.length > 0) {
      if (autoMatchImagery) onAutoMatchChange?.(false);
      onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
      return;
    }

    if (!isImageryLast && waybackItems[currentImageryIndex + 1]) {
      if (autoMatchImagery) onAutoMatchChange?.(false);
      onImageryChange(waybackItems[currentImageryIndex + 1].releaseNum);
    }
  };

  // Progress label for the imagery-history pipeline. Discovery has no
  // per-request granularity, so it shows an expected duration instead;
  // metadata verification reports real counts.
  const loadProgressLabel =
    loadProgress?.phase === "metadata"
      ? `verifying imagery dates ${loadProgress.done}/${loadProgress.total} …`
      : "scanning imagery history — usually 10–20 s …";

  const shouldShowBlockingLoading = isLoading && !hasSelectedBasemap;
  const hasNoImagery = waybackItems.length === 0 && !isLoading && !hasSelectedBasemap;

  // Get the base map year for display
  const selectedImageryDate = selectedItem
    ? getImageryDate(selectedItem)
    : undefined;
  const baseMapYear = selectedImageryDate?.getFullYear();
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
              options={PREDICTION_YEARS.map((year) => ({
                value: year,
                label: year,
              }))}
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
            <Tooltip
              title={
                autoMatchImagery
                  ? "Auto-matching imagery to year"
                  : "Manual imagery selection"
              }
            >
              <Button
                size="small"
                type={autoMatchImagery ? "primary" : "default"}
                icon={<LinkOutlined />}
                onClick={() => {
                  onRequestLocalImagery?.();
                  onAutoMatchChange?.(!autoMatchImagery);
                }}
                className="ml-1"
              />
            </Tooltip>
          )}
        </div>
      </div>

      {/* Row 2: Base Layer with label and informative message */}
      {isWaybackActive && (
        <div className="flex w-full flex-col items-center gap-1 border-t border-gray-100 pt-2">
          {/* Discovery failed: dates are ESRI release dates, not capture dates */}
          {isUnverifiedFallback && !compactMode && (
            <div className="flex items-center gap-1.5 text-xs">
              <WarningOutlined
                className="text-amber-500"
                style={{ fontSize: "12px" }}
              />
              <Text type="secondary">
                Imagery history unavailable — dates show ESRI release dates
              </Text>
            </div>
          )}
          {/* Informative message - always visible when imagery is loaded */}
          {!isLoading &&
            waybackItems.length > 0 &&
            selectedItem &&
            !compactMode && (
              <div className="flex items-center gap-1.5 text-xs">
                {yearsMatch ? (
                  <CheckCircleOutlined
                    className="text-green-500"
                    style={{ fontSize: "12px" }}
                  />
                ) : (
                  <WarningOutlined
                    className="text-amber-500"
                    style={{ fontSize: "12px" }}
                  />
                )}
                <Text type="secondary">
                  {yearsMatch ? (
                    <>
                      {predictionYear} {activeProductName} with matching{" "}
                      <span
                        className="text-green-500"
                        style={{ fontSize: "14px", lineHeight: 0 }}
                      >
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
            {shouldShowBlockingLoading ? (
              <div className="flex items-center gap-2 text-gray-400">
                <Spin
                  indicator={<LoadingOutlined style={{ fontSize: 14 }} spin />}
                />
                <span className="text-xs">{loadProgressLabel}</span>
              </div>
            ) : hasNoImagery ? (
              <Text type="secondary" className="text-xs text-gray-400">
                No satellite imagery available at this location
              </Text>
            ) : (
              <>
                {/* Navigation arrow: ← older */}
                {canNavigateImagery && (
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
                  <CameraOutlined
                    className="text-gray-400"
                    style={{ fontSize: "12px" }}
                  />

                  {selectedItem ? (
                    <Tooltip
                      title={
                        <div className="text-center">
                          <div className="font-medium">Satellite Imagery</div>
                          <div className="mt-1">
                            Date: {formatDate(selectedImageryDate)}
                          </div>
                          {!selectedItem.acquisitionDate && (
                            <div className="text-gray-300">
                              Release date — actual capture may be older
                            </div>
                          )}
                          {selectedItem.provider && (
                            <div>Provider: {selectedItem.provider}</div>
                          )}
                          {selectedItem.source && (
                            <div>Satellite: {selectedItem.source}</div>
                          )}
                          {selectedItem.resolution && (
                            <div>
                              Resolution:{" "}
                              {formatResolution(selectedItem.resolution)}
                            </div>
                          )}
                          {hasMultipleImages && (
                            <div className="mt-1 text-gray-300">
                              Image {currentImageryIndex + 1} of{" "}
                              {waybackItems.length}
                            </div>
                          )}
                        </div>
                      }
                      placement="top"
                    >
                      <div className="flex cursor-help items-center gap-1.5 text-xs">
                        <span className="font-medium text-gray-700">
                          {formatDate(selectedImageryDate)}
                          {!selectedItem.acquisitionDate && (
                            <span className="text-gray-400"> (release)</span>
                          )}
                        </span>
                        {!compactMode && selectedItem.provider && (
                          <span className="text-gray-400">·</span>
                        )}
                        {!compactMode && selectedItem.provider && (
                          <span className="text-gray-500">
                            {selectedItem.provider}
                          </span>
                        )}
                        {!compactMode && selectedItem.source && (
                          <span className="text-gray-400">
                            {selectedItem.source}
                          </span>
                        )}
                        {!compactMode && selectedItem.resolution && (
                          <>
                            <span className="text-gray-400">·</span>
                            <span className="text-gray-500">
                              {formatResolution(selectedItem.resolution)}
                            </span>
                          </>
                        )}
                      </div>
                    </Tooltip>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span>Satellite basemap active</span>
                      {isLoading && !compactMode && (
                        <span className="inline-flex items-center gap-1.5 text-gray-400">
                          <Spin
                            indicator={
                              <LoadingOutlined
                                style={{ fontSize: 11 }}
                                spin
                              />
                            }
                          />
                          {loadProgressLabel}
                        </span>
                      )}
                      {!isLoading && isUsingDefaultBasemap && !compactMode && (
                        <span className="text-gray-400">
                          local imagery dates unavailable
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Navigation arrow: → newer */}
                {canNavigateImagery && (
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
                      <div className="mt-1">
                        Predictions are available for all years (2017-2025).
                      </div>
                      <div className="mt-1">
                        <span className="text-green-400">•</span> indicates base
                        map imagery is available for that year.
                      </div>
                      <div className="mt-1 text-gray-300">
                        The base map shows satellite imagery for visual context
                        only.
                      </div>
                    </div>
                  }
                >
                  <InfoCircleOutlined
                    className="ml-1 cursor-help text-gray-400"
                    style={{ fontSize: "12px" }}
                  />
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
