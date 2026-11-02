import { useEffect, useRef, useState } from "react";
import type { Map as OLMap } from "ol";
import Feature from "ol/Feature";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import type BaseLayer from "ol/layer/Base";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import { TileWMS, XYZ } from "ol/source";
import VectorSource from "ol/source/Vector";
import { getDistance } from "ol/sphere";
import { Circle, Fill, Stroke, Style } from "ol/style";

import { describeGeorefReason, describeReference, fillTileTemplate, offsetColor, orderedReferences } from "../../../utils/georefCheck";
import type { IGeorefCheck, IGeorefReferenceEvidence, IGeorefReferenceViewer } from "../../../types/georefCheck";

/** The tile source of a keyless reference (WMS as 256 px tiles). */
function referenceSource(viewer: IGeorefReferenceViewer): XYZ | TileWMS {
	if (viewer.kind === "xyz") {
		return new XYZ({
			tileUrlFunction: ([z, x, y]) => fillTileTemplate(viewer.url, z, x, y),
			maxZoom: viewer.max_zoom,
			crossOrigin: "anonymous",
			attributions: viewer.attribution,
		});
	}
	return new TileWMS({
		url: viewer.url,
		params: { LAYERS: viewer.layers, VERSION: viewer.version, FORMAT: viewer.format, TILED: true },
		crossOrigin: "anonymous",
		attributions: viewer.attribution,
	});
}

/** Dot = matched spot in the drone image, line = the same spot in the reference, coloured by offset. */
function matchFeatures(reference: IGeorefReferenceEvidence | undefined): Feature[] {
	return (reference?.sample_pairs ?? []).map(([lonA, latA, lonB, latB, inlier = 1]) => {
		const a = fromLonLat([lonA, latA]);
		const b = fromLonLat([lonB, latB]);
		const feature = new Feature(new LineString([a, b]));
		// matches the fit rejected are grey: they show where the matcher looked, not the offset
		const color = inlier ? offsetColor(getDistance([lonA, latA], [lonB, latB])) : "#9ca3af";
		feature.setStyle([
			new Style({ stroke: new Stroke({ color, width: inlier ? 2 : 1 }) }),
			new Style({ geometry: new Point(a), image: new Circle({ radius: 3, fill: new Fill({ color }), stroke: new Stroke({ color: "#fff", width: 1 }) }) }),
		]);
		return feature;
	});
}

export interface IGeorefReferenceOption {
	value: string;
	label: string;
	/** false when only the matches can be drawn */
	hasImagery: boolean;
}

/** Every reference with imagery to show or matches to draw, deciding ones first. */
export function georefReferenceOptions(check: IGeorefCheck): IGeorefReferenceOption[] {
	return orderedReferences(check)
		.filter((r) => check.metadata.references?.[r.provider]?.viewer || r.sample_pairs.length > 0)
		.map((r) => {
			const call = r.decides && r.vote && r.vote !== "unstable" ? `decided ${r.vote}` : describeGeorefReason(r.reason);
			const offset = r.p90_m === null ? "" : ` · ${r.p90_m.toFixed(1)} m`;
			return {
				value: r.provider,
				label: `${describeReference(check, r.provider)} · ${call}${offset}`,
				hasImagery: !!check.metadata.references?.[r.provider]?.viewer,
			};
		});
}

interface UseGeorefLayersOptions {
	map: OLMap | null;
	orthoLayer: BaseLayer | null;
	check: IGeorefCheck | null;
	provider: string | undefined;
	showMatches: boolean;
	/** drone image opacity, 0-100, while the reference shows under it */
	droneOpacity: number;
}

/** Georeferencing mode on the audit map: the chosen reference under the drone image and the
 * check's match lines on top. Everything is removed and the drone opacity restored on exit. */
export function useGeorefLayers({ map, orthoLayer, check, provider, showMatches, droneOpacity }: UseGeorefLayersOptions) {
	const active = !!map && !!check;
	const layersRef = useRef<{ reference: TileLayer<XYZ | TileWMS>; matches: VectorLayer<VectorSource> } | null>(null);
	// bumps when the layers are rebuilt, so the effects below apply to the new ones
	const [epoch, setEpoch] = useState(0);

	useEffect(() => {
		if (!map || !active) return;
		const layers = { reference: new TileLayer<XYZ | TileWMS>({ preload: 0 }), matches: new VectorLayer({ source: new VectorSource(), zIndex: 90 }) };
		const all = map.getLayers();
		const orthoIndex = orthoLayer ? all.getArray().indexOf(orthoLayer) : -1;
		// the reference sits right under the drone image, the matches above everything
		all.insertAt(orthoIndex >= 0 ? orthoIndex : all.getLength(), layers.reference);
		map.addLayer(layers.matches);
		layersRef.current = layers;
		setEpoch((e) => e + 1);
		return () => {
			for (const layer of [layers.reference, layers.matches]) {
				map.removeLayer(layer);
				layer.getSource()?.dispose();
				layer.dispose();
			}
			layersRef.current = null;
			orthoLayer?.setOpacity(1);
		};
	}, [map, orthoLayer, active]);

	useEffect(() => {
		const layers = layersRef.current;
		if (!layers || !check) return;
		const viewer = provider ? check.metadata.references?.[provider]?.viewer : null;
		const previous = layers.reference.getSource();
		layers.reference.setSource(viewer ? referenceSource(viewer) : null);
		previous?.dispose();
		const source = layers.matches.getSource()!;
		source.clear();
		source.addFeatures(matchFeatures(check.reference_evidence.find((r) => r.provider === provider)));
	}, [epoch, check, provider]);

	useEffect(() => {
		layersRef.current?.matches.setVisible(showMatches);
	}, [epoch, showMatches]);

	useEffect(() => {
		if (layersRef.current) orthoLayer?.setOpacity(droneOpacity / 100);
	}, [epoch, orthoLayer, droneOpacity]);
}
