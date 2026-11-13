import { useEffect, useRef } from "react";
import { useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";
import type { ISectionLayers } from "../../../utils/auditChecks";

/** While a step is open, the map shows the layers it needs: the AOI outline and the
 * prediction layers are switched on or off as the step says. What was shown before comes
 * back when the step closes, except a layer the reviewer switched meanwhile. The layer
 * buttons keep working. */
export function useSectionLayers(shows: ISectionLayers | null) {
	const { layerControl, setShowForestCover, setShowDeadwood, setShowAOI } = useDatasetDetailsMap();
	const shown = useRef(layerControl);
	shown.current = layerControl;
	const aoi = shows?.aoi;
	const deadwood = shows?.deadwood;
	const forestCover = shows?.forestCover;
	useEffect(() => {
		if (aoi === undefined || deadwood === undefined || forestCover === undefined) return;
		const before = shown.current;
		setShowForestCover(forestCover);
		setShowDeadwood(deadwood);
		setShowAOI(aoi);
		return () => {
			// a layer still as the step set it goes back; one the reviewer switched stays
			if (shown.current.showForestCover === forestCover) setShowForestCover(before.showForestCover);
			if (shown.current.showDeadwood === deadwood) setShowDeadwood(before.showDeadwood);
			if (shown.current.showAOI === aoi) setShowAOI(before.showAOI);
		};
	}, [aoi, deadwood, forestCover, setShowForestCover, setShowDeadwood, setShowAOI]);
}
