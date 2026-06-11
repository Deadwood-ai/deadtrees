import { useEffect } from "react";
import { findClosestImagery } from "../YearImagerySelector";
import type { WaybackItemWithMetadata } from "../../../hooks/useWaybackItems";

interface Params {
  /** Only run the auto-selection on the mobile presentation. */
  enabled: boolean;
  waybackItems: WaybackItemWithMetadata[];
  selectedReleaseNum: number | null;
  onImageryChange: (releaseNum: number) => void;
  autoMatchImagery: boolean;
  predictionYear: string;
}

/**
 * Mirrors the imagery auto-selection that the desktop `YearImagerySelector`
 * performs internally. On mobile the selector is replaced by a presentational
 * drawer, so the parent runs this hook to keep a valid satellite release
 * selected and matched to the prediction year.
 */
export const useMobileImageryAutoSelect = ({
  enabled,
  waybackItems,
  selectedReleaseNum,
  onImageryChange,
  autoMatchImagery,
  predictionYear,
}: Params) => {
  const isSelectionValid =
    selectedReleaseNum !== null &&
    waybackItems.some((item) => item.releaseNum === selectedReleaseNum);

  // Select imagery when items load or when the current selection is invalid.
  useEffect(() => {
    if (!enabled) return;
    if (waybackItems.length === 0) return;
    if (selectedReleaseNum && isSelectionValid) return;

    if (autoMatchImagery) {
      const closest = findClosestImagery(waybackItems, parseInt(predictionYear));
      if (closest) onImageryChange(closest.releaseNum);
    } else {
      onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
    }
  }, [
    enabled,
    waybackItems,
    selectedReleaseNum,
    isSelectionValid,
    autoMatchImagery,
    predictionYear,
    onImageryChange,
  ]);

  // Re-match imagery when the prediction year changes (if auto-match is on).
  useEffect(() => {
    if (!enabled || !autoMatchImagery) return;
    if (waybackItems.length === 0 || !selectedReleaseNum) return;

    const closest = findClosestImagery(waybackItems, parseInt(predictionYear));
    if (closest && closest.releaseNum !== selectedReleaseNum) {
      onImageryChange(closest.releaseNum);
    }
  }, [
    enabled,
    waybackItems,
    selectedReleaseNum,
    onImageryChange,
    predictionYear,
    autoMatchImagery,
  ]);
};
