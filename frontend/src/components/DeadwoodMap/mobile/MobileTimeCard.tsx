import { Button, Spin, Switch } from "antd";
import {
  CameraOutlined,
  LeftOutlined,
  LinkOutlined,
  LoadingOutlined,
  RightOutlined,
} from "@ant-design/icons";

import {
  resolveWaybackCandidate,
  type WaybackItemWithMetadata,
} from "../../../hooks/useWaybackItems";
import {
  getImageryDate,
  pickAutoMatchImagery,
  PREDICTION_YEARS,
} from "../YearImagerySelector";

interface MobileTimeCardProps {
  predictionYear: string;
  /** Short name of the model product the year applies to, e.g. "Tree and deadwood cover" */
  productName: string;
  isWaybackActive: boolean;
  isLoadingImagery: boolean;
  waybackItems: WaybackItemWithMetadata[];
  selectedReleaseNum: number | null;
  autoMatchImagery: boolean;
  onPredictionYearChange: (year: string) => void;
  onImageryChange: (releaseNum: number) => void;
  onAutoMatchChange: (enabled: boolean) => void;
}

const formatDate = (date: Date | undefined): string | null => {
  if (!date) return null;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const formatResolution = (resolution: number | undefined): string | null => {
  if (!resolution) return null;
  return resolution < 1
    ? `${Math.round(resolution * 100)}cm`
    : `${resolution}m`;
};

const stepperRowClass = "grid grid-cols-[44px_1fr_44px] items-center gap-3";

/**
 * "Time" card for the mobile map settings drawer.
 *
 * Pairs the prediction-year stepper with the satellite-image stepper so the
 * two time choices read as one concept. A "Match image to year" row links
 * them; stepping the imagery by hand switches the link off.
 */
const MobileTimeCard = ({
  predictionYear,
  productName,
  isWaybackActive,
  isLoadingImagery,
  waybackItems,
  selectedReleaseNum,
  autoMatchImagery,
  onPredictionYearChange,
  onImageryChange,
  onAutoMatchChange,
}: MobileTimeCardProps) => {
  const predictionIndex = PREDICTION_YEARS.indexOf(predictionYear);
  // Resolve the selection to the candidate whose imagery it actually shows
  // (releases between two local changes serve identical tiles).
  const selectedImagery = resolveWaybackCandidate(
    waybackItems,
    selectedReleaseNum,
  );
  const imageryIndex = selectedImagery
    ? waybackItems.indexOf(selectedImagery)
    : -1;
  const isSelectionOutsideCandidates =
    selectedReleaseNum !== null && imageryIndex < 0 && waybackItems.length > 0;
  const canStepToOlder = isSelectionOutsideCandidates || imageryIndex > 0;
  const canStepToNewer =
    isSelectionOutsideCandidates ||
    (imageryIndex >= 0 && imageryIndex < waybackItems.length - 1);

  const imageryDate = formatDate(getImageryDate(selectedImagery));
  const imageryPosition =
    imageryIndex >= 0 ? `${imageryIndex + 1} of ${waybackItems.length}` : null;
  // Date is the headline when known; otherwise fall back to the position so
  // we never shout "Unknown date" at the user.
  const imageryPrimary =
    imageryDate ?? (imageryPosition ? `Image ${imageryPosition}` : "Satellite image");
  const imagerySecondary = [
    imageryDate ? imageryPosition : null,
    selectedImagery?.provider || selectedImagery?.source,
    formatResolution(selectedImagery?.resolution),
  ]
    .filter(Boolean)
    .join(" · ");

  const matchImageryToYear = (year: string) => {
    if (!autoMatchImagery || waybackItems.length === 0) return;
    const nextReleaseNum = pickAutoMatchImagery(
      waybackItems,
      Number.parseInt(year),
      selectedReleaseNum,
    );
    if (nextReleaseNum !== null) onImageryChange(nextReleaseNum);
  };

  const selectPredictionYear = (year: string) => {
    onPredictionYearChange(year);
    matchImageryToYear(year);
  };

  const stepImagery = (offset: number) => {
    if (isSelectionOutsideCandidates) {
      // Enter the discovered candidate list at its newest image while keeping
      // the default basemap sticky until the user explicitly steps.
      const newestCandidate = waybackItems[waybackItems.length - 1];
      if (!newestCandidate) return;
      if (autoMatchImagery) onAutoMatchChange(false);
      onImageryChange(newestCandidate.releaseNum);
      return;
    }

    const item = waybackItems[imageryIndex + offset];
    if (!item) return;
    // Hand-picking an image breaks the link to the prediction year.
    if (autoMatchImagery) onAutoMatchChange(false);
    onImageryChange(item.releaseNum);
  };

  const toggleAutoMatch = () => {
    const next = !autoMatchImagery;
    onAutoMatchChange(next);
    if (next && waybackItems.length > 0) {
      const nextReleaseNum = pickAutoMatchImagery(
        waybackItems,
        Number.parseInt(predictionYear),
        selectedReleaseNum,
      );
      if (nextReleaseNum !== null) onImageryChange(nextReleaseNum);
    }
  };

  const showImagerySection =
    isWaybackActive && (isLoadingImagery || waybackItems.length > 0);

  return (
    <div className="rounded-[22px] border border-slate-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
      <div className={stepperRowClass}>
        <Button
          icon={<LeftOutlined />}
          disabled={predictionIndex <= 0}
          onClick={() => selectPredictionYear(PREDICTION_YEARS[predictionIndex - 1])}
          aria-label="Previous prediction year"
          className="!h-11 !w-11"
        />
        <div className="min-w-0 rounded-2xl bg-emerald-950 px-4 py-2.5 text-center text-white">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100/80">
            Prediction year
          </div>
          <div className="text-3xl font-semibold leading-tight">
            {predictionYear}
          </div>
          <div className="truncate text-[11px] text-emerald-100/80">
            {productName}
          </div>
        </div>
        <Button
          icon={<RightOutlined />}
          disabled={predictionIndex >= PREDICTION_YEARS.length - 1}
          onClick={() => selectPredictionYear(PREDICTION_YEARS[predictionIndex + 1])}
          aria-label="Next prediction year"
          className="!h-11 !w-11"
        />
      </div>

      {isWaybackActive && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-500">
            <CameraOutlined />
            <span>Satellite image</span>
          </div>

          {isLoadingImagery ? (
            <div className="flex h-[68px] items-center justify-center gap-2 rounded-2xl bg-slate-50 text-sm text-slate-500">
              <Spin
                indicator={<LoadingOutlined style={{ fontSize: 16 }} spin />}
              />
              Finding imagery
            </div>
          ) : waybackItems.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
              No satellite imagery is available at this location.
            </div>
          ) : (
            <div className={stepperRowClass}>
              <Button
                icon={<LeftOutlined />}
                disabled={!canStepToOlder}
                onClick={() => stepImagery(-1)}
                aria-label="Older satellite image"
                className="!h-11 !w-11"
              />
              <div className="min-w-0 rounded-2xl bg-slate-50 px-4 py-2.5 text-center">
                <div className="truncate text-sm font-semibold text-slate-950">
                  {imageryPrimary}
                </div>
                <div className="mt-0.5 truncate text-xs text-slate-500">
                  {imagerySecondary || "Satellite imagery"}
                </div>
              </div>
              <Button
                icon={<RightOutlined />}
                disabled={!canStepToNewer}
                onClick={() => stepImagery(1)}
                aria-label="Newer satellite image"
                className="!h-11 !w-11"
              />
            </div>
          )}
        </div>
      )}

      {showImagerySection && (
        <div
          className="mt-3 flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2"
          onClick={toggleAutoMatch}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <LinkOutlined
              className={
                autoMatchImagery ? "text-emerald-700" : "text-slate-400"
              }
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900">
                Match image to year
              </div>
              <div className="truncate text-xs text-slate-500">
                Shows the image closest to {predictionYear}
              </div>
            </div>
          </div>
          <span onClick={(event) => event.stopPropagation()}>
            <Switch
              checked={autoMatchImagery}
              onChange={toggleAutoMatch}
              disabled={isLoadingImagery || waybackItems.length === 0}
              aria-label="Match satellite image to prediction year"
            />
          </span>
        </div>
      )}
    </div>
  );
};

export default MobileTimeCard;
