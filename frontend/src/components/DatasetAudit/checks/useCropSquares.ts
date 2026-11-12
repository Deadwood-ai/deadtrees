import { useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import { unByKey } from "ol/Observable";
import Feature from "ol/Feature";
import GeoJSON from "ol/format/GeoJSON";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Fill, Stroke, Style, Text } from "ol/style";
import type { IAuditCrop } from "../../../types/auditChecks";

const format = new GeoJSON({ dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" });
const CROP_COLOR = "#7fd3e6";
/** A crop the check counted major: orange and dashed, so it does not rest on colour alone
 * (red and green look alike to many people). */
const FLAGGED_COLOR = "#ff8a00";

interface UseCropSquaresOptions {
	map: OLMap | null;
	/** the crops in display order; their number is the position + 1 */
	crops: IAuditCrop[] | null;
	selectedId: number | null;
	/** crops the check counted major: drawn orange, thicker and dashed */
	flagged?: Set<number>;
	onSelect: (cropId: number) => void;
}

/** The crops a check judged as numbered squares on the audit map; a click selects one. */
export function useCropSquares({ map, crops, selectedId, flagged, onSelect }: UseCropSquaresOptions) {
	const layerRef = useRef<VectorLayer<VectorSource> | null>(null);
	const [epoch, setEpoch] = useState(0);
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const active = !!map && !!crops;

	useEffect(() => {
		if (!map || !active) return;
		const layer = new VectorLayer({ source: new VectorSource(), zIndex: 95 });
		map.addLayer(layer);
		layerRef.current = layer;
		setEpoch((e) => e + 1);
		const clickKey = map.on("singleclick", (event) => {
			const hit = map.forEachFeatureAtPixel(event.pixel, (f) => f, { layerFilter: (l) => l === layer });
			const id = hit?.get("cropId");
			if (typeof id === "number") onSelectRef.current(id);
		});
		return () => {
			unByKey(clickKey);
			map.removeLayer(layer);
			layer.getSource()?.dispose();
			layer.dispose();
			layerRef.current = null;
		};
	}, [map, active]);

	useEffect(() => {
		const source = layerRef.current?.getSource();
		if (!source || !crops) return;
		source.clear();
		source.addFeatures(
			crops.map((crop, i) => {
				const feature = format.readFeature(crop.geometry) as Feature;
				const selected = crop.id === selectedId;
				const marked = !!flagged?.has(crop.id);
				const color = selected ? "#ffffff" : marked ? FLAGGED_COLOR : CROP_COLOR;
				feature.set("cropId", crop.id);
				feature.setStyle(
					new Style({
						// a near-transparent fill keeps the whole square clickable
						fill: new Fill({ color: selected ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.01)" }),
						stroke: new Stroke({ color, width: selected ? 4 : marked ? 3 : 2, lineDash: marked && !selected ? [10, 6] : undefined }),
						text: new Text({
							text: marked ? `${i + 1} !` : String(i + 1),
							font: "bold 14px system-ui, sans-serif",
							fill: new Fill({ color: "#fff" }),
							stroke: new Stroke({ color: "rgba(0,0,0,0.6)", width: 3 }),
						}),
					}),
				);
				return feature;
			}),
		);
	}, [epoch, crops, selectedId, flagged]);
}

/** Zoom the map to one crop, keeping some context around it. */
export function zoomToCrop(map: OLMap | null, crop: IAuditCrop | undefined) {
	if (!map || !crop) return;
	const geometry = format.readGeometry(crop.geometry);
	if (!geometry) return;
	map.getView().fit(geometry.getExtent(), { padding: [120, 120, 120, 120], duration: 250, maxZoom: 22 });
}
