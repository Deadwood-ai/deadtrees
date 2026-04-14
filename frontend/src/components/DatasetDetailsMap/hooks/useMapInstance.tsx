import { createContext, useContext, useRef, useState, useCallback, useMemo, ReactNode } from "react";
import type { Map as OLMap } from "ol";
import type TileLayerWebGL from "ol/layer/WebGLTile.js";
import type VectorTileLayer from "ol/layer/VectorTile";
import type VectorLayer from "ol/layer/Vector";
import type VectorSource from "ol/source/Vector";
import { Overlay } from "ol";
import { fromLonLat } from "ol/proj";
import { palette } from "../../../theme/palette";

/**
 * Map instance context - replaces forwardRef pattern for sharing map methods
 * 
 * This context provides:
 * 1. Map instance ref (for components that need direct access)
 * 2. Layer refs (for updating visibility/opacity)
 * 3. Action methods (zoom, flash, refresh) that components can call
 */

interface LayerRefs {
	basemap?: unknown;
	orthoCog?: TileLayerWebGL;
	deadwoodVector?: VectorTileLayer;
	forestCoverVector?: VectorTileLayer;
	selectionLayer?: VectorTileLayer;
	aoiVector?: VectorLayer<VectorSource>;
	aoiMask?: VectorLayer<VectorSource>;
	editableAOI?: VectorLayer<VectorSource>;
}

interface MapInstanceContextValue {
	// Map instance
	mapRef: React.MutableRefObject<OLMap | null>;
	setMap: (map: OLMap | null) => void;
	isMapReady: boolean;

	// Layer refs
	layerRefs: React.MutableRefObject<LayerRefs>;

	// Actions
	refreshVectorLayers: () => void;
	zoomToExtent: (minLon: number, minLat: number, maxLon: number, maxLat: number, padding?: number) => void;
	flashLocation: (lon: number, lat: number) => void;
}

const MapInstanceContext = createContext<MapInstanceContextValue | null>(null);

export function MapInstanceProvider({ children }: { children: ReactNode }) {
	const mapRef = useRef<OLMap | null>(null);
	const layerRefs = useRef<LayerRefs>({});
	const [isMapReady, setIsMapReady] = useState(false);

	const setMap = useCallback((map: OLMap | null) => {
		mapRef.current = map;
		setIsMapReady(!!map);
	}, []);

	const refreshVectorLayers = useCallback(() => {
		const deadwoodSource = layerRefs.current.deadwoodVector?.getSource();
		const forestCoverSource = layerRefs.current.forestCoverVector?.getSource();

		if (deadwoodSource) {
			deadwoodSource.refresh();
		}
		if (forestCoverSource) {
			forestCoverSource.refresh();
		}
	}, []);

	const zoomToExtent = useCallback((minLon: number, minLat: number, maxLon: number, maxLat: number, padding = 100) => {
		if (!mapRef.current) return;

		const minCoord = fromLonLat([minLon, minLat]);
		const maxCoord = fromLonLat([maxLon, maxLat]);

		mapRef.current.getView().fit(
			[minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]],
			{ padding: [padding, padding, padding, padding], duration: 500, maxZoom: 20 }
		);
	}, []);

	const flashLocation = useCallback((lon: number, lat: number) => {
		if (!mapRef.current) return;

		const coord = fromLonLat([lon, lat]);

		// Create a flash overlay
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

		// Remove after animation
		setTimeout(() => {
			mapRef.current?.removeOverlay(flashOverlay);
		}, 1500);
	}, []);

	const value = useMemo(() => ({
		mapRef,
		setMap,
		isMapReady,
		layerRefs,
		refreshVectorLayers,
		zoomToExtent,
		flashLocation,
	}), [setMap, isMapReady, refreshVectorLayers, zoomToExtent, flashLocation]);

	return (
		<MapInstanceContext.Provider value={value}>
			{children}
		</MapInstanceContext.Provider>
	);
}

export function useMapInstance() {
	const context = useContext(MapInstanceContext);
	if (!context) {
		throw new Error("useMapInstance must be used within a MapInstanceProvider");
	}
	return context;
}

/**
 * Optional hook that returns null if not in provider (for optional usage)
 */
export function useMapInstanceOptional() {
	return useContext(MapInstanceContext);
}
