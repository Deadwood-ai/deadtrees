import { useCallback } from "react";
import type { Map as OLMap } from "ol";
import { Overlay } from "ol";
import { fromLonLat } from "ol/proj";
import { palette } from "../../../theme/palette";

export interface UseMapUtilitiesOptions {
	/** Map instance ref */
	mapRef: React.MutableRefObject<OLMap | null>;
}

export interface UseMapUtilitiesReturn {
	/** Zoom to a bounding box */
	zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
	/** Flash a location with animation */
	flashLocation: (lon: number, lat: number) => void;
	/** Get current map instance */
	getMap: () => OLMap | null;
}

/**
 * Hook for common map utility functions
 * 
 * Provides:
 * - Zoom to extent functionality
 * - Flash location animation
 * - Map instance getter
 */
export function useMapUtilities({
	mapRef,
}: UseMapUtilitiesOptions): UseMapUtilitiesReturn {
	// Zoom to bounding box
	const zoomToExtent = useCallback((
		minLon: number,
		minLat: number,
		maxLon: number,
		maxLat: number,
		padding = 100
	) => {
		if (!mapRef.current) return;

		const minCoord = fromLonLat([minLon, minLat]);
		const maxCoord = fromLonLat([maxLon, maxLat]);

		mapRef.current.getView().fit(
			[minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]],
			{
				padding: [padding, padding, padding, padding],
				duration: 500,
				maxZoom: 20,
			}
		);
	}, [mapRef]);

	// Flash a location with animated circle
	const flashLocation = useCallback((lon: number, lat: number) => {
		if (!mapRef.current) return;

		const coord = fromLonLat([lon, lat]);

		// Create flash element
		const flashEl = document.createElement("div");
		flashEl.style.cssText = `
			width: 40px; height: 40px; 
			border-radius: 50%; 
			border: 4px solid ${palette.primary[500]};
			background: rgba(59, 130, 246, 0.3);
			animation: flash-pulse 1.5s ease-out;
			pointer-events: none;
			transform: translate(-50%, -50%);
		`;

		// Add animation styles if not already present
		if (!document.getElementById("flash-animation-style")) {
			const style = document.createElement("style");
			style.id = "flash-animation-style";
			style.textContent = `
				@keyframes flash-pulse {
					0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; }
					100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
				}
			`;
			document.head.appendChild(style);
		}

		const flashOverlay = new Overlay({
			element: flashEl,
			position: coord,
			positioning: "center-center",
		});

		mapRef.current.addOverlay(flashOverlay);

		// Remove after animation completes
		setTimeout(() => {
			mapRef.current?.removeOverlay(flashOverlay);
		}, 1500);
	}, [mapRef]);

	// Get map instance
	const getMap = useCallback(() => mapRef.current, [mapRef]);

	return {
		zoomToExtent,
		flashLocation,
		getMap,
	};
}
