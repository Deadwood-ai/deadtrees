import type { Map } from "ol";
import { unByKey } from "ol/Observable";
import { useEffect, useState, type RefObject } from "react";

import {
  buildPriwaBasemapTilePlan,
  getPriwaBasemapSelectionExtent,
  type IPriwaBasemapTilePlan,
} from "./priwaOfflineBasemap";

export interface IPriwaOfflineSelectionPlan extends IPriwaBasemapTilePlan {
  selectionZoom: number;
}

export function usePriwaOfflineSelectionPlan(
  mapRef: RefObject<Map | null>,
  isSelecting: boolean,
) {
  const [plan, setPlan] = useState<IPriwaOfflineSelectionPlan | null>(null);

  useEffect(() => {
    if (!isSelecting) {
      setPlan(null);
      return;
    }

    const map = mapRef.current;
    const size = map?.getSize();
    if (!map || !size) return;

    const updatePlan = () => {
      const currentSize = map.getSize();
      if (!currentSize) return;
      const viewportExtent = map.getView().calculateExtent(currentSize) as [
        number,
        number,
        number,
        number,
      ];
      setPlan({
        ...buildPriwaBasemapTilePlan(
          getPriwaBasemapSelectionExtent(viewportExtent),
        ),
        selectionZoom: map.getView().getZoom() ?? 18,
      });
    };

    updatePlan();
    const moveEndKey = map.on("moveend", updatePlan);
    const sizeChangeKey = map.on("change:size", updatePlan);
    return () => unByKey([moveEndKey, sizeChangeKey]);
  }, [isSelecting, mapRef]);

  return plan;
}
