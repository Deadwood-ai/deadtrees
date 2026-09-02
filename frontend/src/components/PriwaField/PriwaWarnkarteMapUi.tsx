import { useState } from "react";

import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";
import PriwaMapLayersSheet from "./PriwaMapLayersSheet";
import PriwaWarnkarteLegend from "./PriwaWarnkarteLegend";
import type { PriwaBaseLayer } from "./types";

interface PriwaWarnkarteMapUiProps {
  isMobile: boolean;
  isLayersOpen: boolean;
  baseLayer: PriwaBaseLayer;
  overlay: IPriwaWarnkarteOverlay | null;
  isLoading: boolean;
  isVisible: boolean;
  onCloseLayers: () => void;
  onBaseLayerChange: (layer: PriwaBaseLayer) => void;
  onVisibilityChange: (visible: boolean) => void;
  onZoom: () => void;
}

export default function PriwaWarnkarteMapUi({
  isMobile,
  isLayersOpen,
  baseLayer,
  overlay,
  isLoading,
  isVisible,
  onCloseLayers,
  onBaseLayerChange,
  onVisibilityChange,
  onZoom,
}: PriwaWarnkarteMapUiProps) {
  const [isMobileLegendVisible, setMobileLegendVisible] = useState(true);
  const isAvailable = !!overlay?.features.length;
  const isActive = isAvailable && isVisible;

  return (
    <>
      {isMobile && (
        <PriwaMapLayersSheet
          open={isLayersOpen}
          baseLayer={baseLayer}
          warnkarteAvailable={isAvailable}
          warnkarteLoading={isLoading}
          warnkarteVisible={isVisible}
          legendVisible={isMobileLegendVisible}
          onClose={onCloseLayers}
          onBaseLayerChange={onBaseLayerChange}
          onWarnkarteVisibilityChange={onVisibilityChange}
          onLegendVisibilityChange={setMobileLegendVisible}
          onZoomToWarnkarte={onZoom}
        />
      )}

      {isActive && (!isMobile || isMobileLegendVisible) && (
        <PriwaWarnkarteLegend
          sourceDate={overlay?.source_date ?? null}
          onDismiss={isMobile ? () => setMobileLegendVisible(false) : undefined}
        />
      )}
    </>
  );
}
