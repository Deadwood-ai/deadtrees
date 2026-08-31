import { useEffect, type RefObject } from "react";

import {
  createPriwaOfflineAreaFeature,
  createPriwaOfflineAreaLayer,
} from "./createPriwaOfflineAreaLayer";
import type { IPriwaOfflineBasemapArea } from "./priwaOfflineStore";

export function usePriwaOfflineAreaLayer(
  layerRef: RefObject<ReturnType<typeof createPriwaOfflineAreaLayer> | null>,
  areas: IPriwaOfflineBasemapArea[],
  isVisible: boolean,
) {
  useEffect(() => {
    const layer = layerRef.current;
    const source = layer?.getSource();
    if (!layer || !source) return;

    source.clear();
    source.addFeatures(
      areas.map((area) => createPriwaOfflineAreaFeature(area.extent3857)),
    );
    layer.setVisible(isVisible);
  }, [areas, isVisible, layerRef]);
}
