import { useEffect } from "react";
import { pickAutoMatchImagery } from "../YearImagerySelector";
import type { WaybackItemWithMetadata } from "../../../hooks/useWaybackItems";

interface Params {
  /** Only run the auto-selection on the mobile presentation. */
  enabled: boolean;
  waybackItems: WaybackItemWithMetadata[];
  selectedReleaseNum: number | null;
  onImageryChange: (releaseNum: number) => void;
  autoMatchImagery: boolean;
  predictionYear: string;
  /** Whether local change-detected candidates are being fetched */
  isRefining?: boolean;
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
  isRefining = false,
}: Params) => {
  // Select imagery when items load or when the prediction year changes. Manual
  // mode keeps the active basemap sticky even if it is outside the local
  // candidate list.
  useEffect(() => {
    if (!enabled) return;
    if (waybackItems.length === 0) return;

    if (autoMatchImagery) {
      // Wait for the location-specific candidate list before re-matching so
      // the basemap is not swapped twice (see YearImagerySelector).
      if (isRefining) return;
      const nextReleaseNum = pickAutoMatchImagery(
        waybackItems,
        parseInt(predictionYear),
        selectedReleaseNum,
      );
      if (nextReleaseNum !== null) {
        onImageryChange(nextReleaseNum);
      }
    } else if (!selectedReleaseNum) {
      onImageryChange(waybackItems[waybackItems.length - 1].releaseNum);
    }
  }, [
    enabled,
    waybackItems,
    selectedReleaseNum,
    autoMatchImagery,
    predictionYear,
    onImageryChange,
    isRefining,
  ]);
};
