import { useState } from "react";

/** The prediction's opacity over the raw image, kept per browser like a map's layer opacity. */
export const OPACITY_KEY = "audit.cropPredictionOpacity";
export const DEFAULT_OPACITY = 0.6;
export const OPACITY_STEP = 0.2;

const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

function storedOpacity(): number {
	try {
		const stored = window.localStorage.getItem(OPACITY_KEY);
		// Number("") is 0: an empty value counts as unset
		const value = stored ? Number(stored) : NaN;
		return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_OPACITY;
	} catch {
		return DEFAULT_OPACITY;
	}
}

/** The opacity (0 raw only, 1 the prediction image alone), a setter that clamps and remembers it,
 * and one step down or up for the keys. */
export function usePredictionOpacity() {
	const [opacity, setOpacityState] = useState(storedOpacity);
	const setOpacity = (value: number) => {
		const next = clamp(value);
		setOpacityState(next);
		try {
			window.localStorage.setItem(OPACITY_KEY, String(next));
		} catch {
			// the choice lasts for this page only
		}
	};
	return {
		opacity,
		setOpacity,
		weaker: () => setOpacity(opacity - OPACITY_STEP),
		stronger: () => setOpacity(opacity + OPACITY_STEP),
	};
}
