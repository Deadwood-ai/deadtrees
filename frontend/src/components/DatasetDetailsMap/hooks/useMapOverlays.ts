import { useEffect, useRef, useCallback, useState } from "react";
import type { Map as OLMap } from "ol";
import { Overlay } from "ol";
import type { Coordinate } from "ol/coordinate";

export interface TooltipContent {
	type: string;
	status: string;
}

export interface PopoverInfo {
	type: string;
	status: string;
	layerType: "deadwood" | "forest_cover";
	correctionId?: number;
	geometryId?: number;
	correctionOperation?: string;
}

export interface UseMapOverlaysOptions {
	/** Map instance */
	map: OLMap | null;
	/** Tooltip element ref */
	tooltipRef: React.RefObject<HTMLDivElement | null>;
	/** Popover element ref */
	popoverRef: React.RefObject<HTMLDivElement | null>;
	/** Whether overlays are enabled (disabled during editing) */
	enabled?: boolean;
}

export interface UseMapOverlaysReturn {
	/** Tooltip overlay instance */
	tooltipOverlay: Overlay | null;
	/** Popover overlay instance */
	popoverOverlay: Overlay | null;
	/** Current tooltip content */
	tooltipContent: TooltipContent | null;
	/** Current popover info */
	popoverInfo: PopoverInfo | null;
	/** Show tooltip at coordinate */
	showTooltip: (content: TooltipContent, coordinate: Coordinate) => void;
	/** Hide tooltip */
	hideTooltip: () => void;
	/** Show popover at coordinate */
	showPopover: (info: PopoverInfo, coordinate: Coordinate) => void;
	/** Hide popover */
	hidePopover: () => void;
}

/**
 * Hook for managing map overlays (tooltip and popover)
 * 
 * Creates and manages:
 * - Tooltip overlay for hover information
 * - Popover overlay for click information
 * - Show/hide logic with state management
 */
export function useMapOverlays({
	map,
	tooltipRef,
	popoverRef,
	enabled = true,
}: UseMapOverlaysOptions): UseMapOverlaysReturn {
	const tooltipOverlayRef = useRef<Overlay | null>(null);
	const popoverOverlayRef = useRef<Overlay | null>(null);
	const [tooltipContent, setTooltipContent] = useState<TooltipContent | null>(null);
	const [popoverInfo, setPopoverInfo] = useState<PopoverInfo | null>(null);

	// Create overlays when map is ready
	useEffect(() => {
		if (!map) return;

		// Create tooltip overlay
		if (tooltipRef.current && !tooltipOverlayRef.current) {
			const tooltipOverlay = new Overlay({
				element: tooltipRef.current,
				positioning: "bottom-center",
				offset: [0, -10],
				stopEvent: false,
			});
			map.addOverlay(tooltipOverlay);
			tooltipOverlayRef.current = tooltipOverlay;
		}

		// Create popover overlay
		if (popoverRef.current && !popoverOverlayRef.current) {
			const popoverOverlay = new Overlay({
				element: popoverRef.current,
				positioning: "bottom-center",
				offset: [0, -10],
				stopEvent: true,
				autoPan: false,
			});
			map.addOverlay(popoverOverlay);
			popoverOverlayRef.current = popoverOverlay;
		}

		// Cleanup
		return () => {
			if (tooltipOverlayRef.current) {
				map.removeOverlay(tooltipOverlayRef.current);
				tooltipOverlayRef.current = null;
			}
			if (popoverOverlayRef.current) {
				map.removeOverlay(popoverOverlayRef.current);
				popoverOverlayRef.current = null;
			}
		};
	}, [map, tooltipRef, popoverRef]);

	// Hide overlays when disabled
	useEffect(() => {
		if (!enabled) {
			tooltipOverlayRef.current?.setPosition(undefined);
			popoverOverlayRef.current?.setPosition(undefined);
			setTooltipContent(null);
			setPopoverInfo(null);
		}
	}, [enabled]);

	// Show tooltip
	const showTooltip = useCallback((content: TooltipContent, coordinate: Coordinate) => {
		if (!enabled) return;
		setTooltipContent(content);
		tooltipOverlayRef.current?.setPosition(coordinate);
	}, [enabled]);

	// Hide tooltip
	const hideTooltip = useCallback(() => {
		setTooltipContent(null);
		tooltipOverlayRef.current?.setPosition(undefined);
	}, []);

	// Show popover
	const showPopover = useCallback((info: PopoverInfo, coordinate: Coordinate) => {
		if (!enabled) return;
		setPopoverInfo(info);
		popoverOverlayRef.current?.setPosition(coordinate);
		// Hide tooltip when popover is shown
		hideTooltip();
	}, [enabled, hideTooltip]);

	// Hide popover
	const hidePopover = useCallback(() => {
		setPopoverInfo(null);
		popoverOverlayRef.current?.setPosition(undefined);
	}, []);

	return {
		tooltipOverlay: tooltipOverlayRef.current,
		popoverOverlay: popoverOverlayRef.current,
		tooltipContent,
		popoverInfo,
		showTooltip,
		hideTooltip,
		showPopover,
		hidePopover,
	};
}
