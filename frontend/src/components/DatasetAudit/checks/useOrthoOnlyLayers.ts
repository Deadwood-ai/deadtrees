import { useEffect, useRef } from "react";
import { useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";

/** While a check that judges the orthophoto alone is open, the map shows only the
 * orthophoto: the AOI outline and the prediction layers are switched off, and what was
 * shown before comes back when the section closes. The layer buttons keep working. */
export function useOrthoOnlyLayers(active: boolean) {
	const { layerControl, setShowForestCover, setShowDeadwood, setShowAOI } = useDatasetDetailsMap();
	const shown = useRef(layerControl);
	shown.current = layerControl;
	useEffect(() => {
		if (!active) return;
		const before = shown.current;
		setShowForestCover(false);
		setShowDeadwood(false);
		setShowAOI(false);
		return () => {
			// a layer the reviewer switched on meanwhile stays on
			if (!shown.current.showForestCover) setShowForestCover(before.showForestCover);
			if (!shown.current.showDeadwood) setShowDeadwood(before.showDeadwood);
			if (!shown.current.showAOI) setShowAOI(before.showAOI);
		};
	}, [active, setShowForestCover, setShowDeadwood, setShowAOI]);
}
