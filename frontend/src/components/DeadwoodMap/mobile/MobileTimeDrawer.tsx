import type { WaybackItemWithMetadata } from "../../../hooks/useWaybackItems";
import MobileBottomSheet from "./MobileBottomSheet";
import MobileTimeCard from "./MobileTimeCard";

interface MobileTimeDrawerProps {
  open: boolean;
  predictionYear: string;
  selectedReleaseNum: number | null;
  waybackItems: WaybackItemWithMetadata[];
  isLoadingImagery: boolean;
  isWaybackActive: boolean;
  /** Whether the basemap renders live imagery rather than a Wayback release */
  isUsingLiveImagery: boolean;
  autoMatchImagery: boolean;
  showForest: boolean;
  showDeadwood: boolean;
  onClose: () => void;
  onPredictionYearChange: (year: string) => void;
  onImageryChange: (releaseNum: number) => void;
  onUseLiveImagery: () => void;
  /** Start discovering the historical releases at this location */
  onBrowseHistory: () => void;
  onAutoMatchChange: (enabled: boolean) => void;
}

/**
 * Bottom sheet for the time dimension of the map: prediction year,
 * satellite image and the link between them. Opened from the year pill.
 */
const MobileTimeDrawer = ({
  open,
  predictionYear,
  selectedReleaseNum,
  waybackItems,
  isLoadingImagery,
  isWaybackActive,
  isUsingLiveImagery,
  autoMatchImagery,
  showForest,
  showDeadwood,
  onClose,
  onPredictionYearChange,
  onImageryChange,
  onUseLiveImagery,
  onBrowseHistory,
  onAutoMatchChange,
}: MobileTimeDrawerProps) => {
  const productName =
    showForest && showDeadwood
      ? "Tree and deadwood cover"
      : showForest
        ? "Tree cover"
        : showDeadwood
          ? "Deadwood cover"
          : "Predictions";

  return (
    <MobileBottomSheet
      open={open}
      onClose={onClose}
      title="Time"
      compactRatio={0.4}
      expandedRatio={0.5}
    >
      <MobileTimeCard
        predictionYear={predictionYear}
        productName={productName}
        isWaybackActive={isWaybackActive}
        isLoadingImagery={isLoadingImagery}
        waybackItems={waybackItems}
        selectedReleaseNum={selectedReleaseNum}
        isUsingLiveImagery={isUsingLiveImagery}
        autoMatchImagery={autoMatchImagery}
        onPredictionYearChange={onPredictionYearChange}
        onImageryChange={onImageryChange}
        onUseLiveImagery={onUseLiveImagery}
        onBrowseHistory={onBrowseHistory}
        onAutoMatchChange={onAutoMatchChange}
      />
    </MobileBottomSheet>
  );
};

export default MobileTimeDrawer;
