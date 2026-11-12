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
	const predictions = shows?.predictions;
	useEffect(() => {
		if (aoi === undefined || predictions === undefined) return;
		const before = shown.current;
		setShowForestCover(predictions);
		setShowDeadwood(predictions);
		setShowAOI(aoi);
		return () => {
			// a layer still as the step set it goes back; one the reviewer switched stays
			if (shown.current.showForestCover === predictions) setShowForestCover(before.showForestCover);
			if (shown.current.showDeadwood === predictions) setShowDeadwood(before.showDeadwood);
			if (shown.current.showAOI === aoi) setShowAOI(before.showAOI);
		};
	}, [aoi, predictions, setShowForestCover, setShowDeadwood, setShowAOI]);
}
