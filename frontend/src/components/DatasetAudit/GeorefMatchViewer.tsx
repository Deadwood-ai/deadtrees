import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Segmented, Slider, Table, Tag, Typography } from "antd";
import { Map, View } from "ol";
import Feature from "ol/Feature";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import TileLayer from "ol/layer/Tile";
import TileLayerWebGL from "ol/layer/WebGLTile.js";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import { GeoTIFF, XYZ } from "ol/source";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { getDistance } from "ol/sphere";

import { Settings } from "../../config";
import { ESRI_WORLD_IMAGERY_ATTRIBUTION } from "../../utils/basemaps";
import { COG_SOURCE_OPTIONS } from "../../utils/cogSourceOptions";
import { describeGeorefReason, describeReference, offsetColor, orderedReferences } from "../../utils/georefCheck";
import type { IGeorefCheck, IGeorefReferenceEvidence } from "../../types/georefCheck";

const { Text } = Typography;

interface GeorefMatchViewerProps {
	open: boolean;
	onClose: () => void;
	check: IGeorefCheck;
	cogPath: string;
}

function matchFeatures(reference: IGeorefReferenceEvidence | undefined): Feature[] {
	return (reference?.sample_pairs ?? []).map(([lonA, latA, lonB, latB]) => {
		const a = fromLonLat([lonA, latA]);
		const b = fromLonLat([lonB, latB]);
		const feature = new Feature(new LineString([a, b]));
		const color = offsetColor(getDistance([lonA, latA], [lonB, latB]));
		feature.setStyle([
			new Style({ stroke: new Stroke({ color, width: 2 }) }),
			new Style({ geometry: new Point(a), image: new Circle({ radius: 3, fill: new Fill({ color }), stroke: new Stroke({ color: "#fff", width: 1 }) }) }),
		]);
		return feature;
	});
}

/** Drone image over the reference the check matched it against, with an opacity
 * slider and the matched points (dot = drone position, line = where the
 * reference shows the same spot; colour by offset). */
export default function GeorefMatchViewer({ open, onClose, check, cogPath }: GeorefMatchViewerProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const mapRef = useRef<Map | null>(null);
	const referenceLayer = useRef(new TileLayer({ preload: 0 }));
	const droneLayer = useRef<TileLayerWebGL | null>(null);
	const matchSource = useRef(new VectorSource());
	const references = useMemo(() => orderedReferences(check), [check]);
	const viewable = references.filter((r) => check.metadata.references?.[r.provider]?.tile_url);
	const [provider, setProvider] = useState<string | undefined>(viewable[0]?.provider);
	const [opacity, setOpacity] = useState(60);

	useEffect(() => {
		if (!open || mapRef.current || !containerRef.current) return;
		const cog = new GeoTIFF({
			sources: [{ url: Settings.COG_BASE_URL + cogPath, nodata: 0, bands: [1, 2, 3] }],
			convertToRGB: true,
			sourceOptions: COG_SOURCE_OPTIONS,
		});
		droneLayer.current = new TileLayerWebGL({ source: cog, opacity: opacity / 100, preload: 0 });
		const map = new Map({
			target: containerRef.current,
			layers: [referenceLayer.current, droneLayer.current, new VectorLayer({ source: matchSource.current })],
			view: new View({ projection: "EPSG:3857", maxZoom: 23 }),
		});
		mapRef.current = map;
		cog.getView().then((options) => {
			if (options?.extent) map.getView().fit(options.extent as number[], { padding: [30, 30, 30, 30] });
		});
		return () => {
			map.setTarget(undefined);
			mapRef.current = null;
		};
		// the map is built once per opening; layer changes go through the effects below
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, cogPath]);

	useEffect(() => {
		const url = provider ? check.metadata.references?.[provider]?.tile_url : null;
		referenceLayer.current.setSource(
			url ? new XYZ({ url, maxZoom: 19, crossOrigin: "anonymous", attributions: ESRI_WORLD_IMAGERY_ATTRIBUTION }) : null,
		);
		matchSource.current.clear();
		matchSource.current.addFeatures(matchFeatures(references.find((r) => r.provider === provider)));
	}, [provider, check, references]);

	useEffect(() => {
		droneLayer.current?.setOpacity(opacity / 100);
	}, [opacity]);

	const columns = [
		{ title: "Reference", dataIndex: "provider", render: (p: string) => describeReference(check, p) },
		{ title: "Matches", dataIndex: "inliers" },
		{ title: "Coverage", dataIndex: "support", render: (s: number) => `${Math.round(s * 100)}%` },
		{ title: "Offset (p90)", dataIndex: "p90_m", render: (m: number | null) => (m === null ? "–" : `${m.toFixed(1)} m`) },
		{
			title: "Call",
			render: (_: unknown, r: IGeorefReferenceEvidence) =>
				r.decides && r.vote !== "unstable" ? (
					<Tag color={r.vote === "good" ? "green" : "red"}>{r.vote}</Tag>
				) : (
					<Text type="secondary" className="text-xs">{describeGeorefReason(r.reason)}</Text>
				),
		},
	];

	return (
		<Modal open={open} onCancel={onClose} footer={null} width={960} title="Georeferencing check: matching" destroyOnClose>
			<div className="mb-2 flex flex-wrap items-center gap-4">
				{viewable.length > 0 ? (
					<Segmented
						size="small"
						value={provider}
						onChange={(v) => setProvider(String(v))}
						options={viewable.map((r) => ({ label: describeReference(check, r.provider), value: r.provider }))}
					/>
				) : (
					<Text type="secondary" className="text-xs">No keyless reference to show; see the table below.</Text>
				)}
				<div className="flex min-w-[220px] items-center gap-2">
					<Text className="text-xs">Drone opacity</Text>
					<Slider className="flex-1" min={0} max={100} value={opacity} onChange={setOpacity} />
				</div>
			</div>
			<div ref={containerRef} className="h-[460px] w-full rounded border border-gray-200" />
			<Text type="secondary" className="mt-1 block text-xs">
				Dots mark matched spots in the drone image; each line runs to the same spot in the reference. Green under 7.5 m, amber under 15 m, red over 15 m.
			</Text>
			<Table
				className="mt-3"
				size="small"
				pagination={false}
				rowKey="provider"
				dataSource={references}
				columns={columns}
				onRow={(r) => ({ onClick: () => check.metadata.references?.[r.provider]?.tile_url && setProvider(r.provider) })}
			/>
			{Object.keys(check.reference_errors).length > 0 && (
				<Text type="secondary" className="mt-2 block text-xs">
					Unavailable: {Object.entries(check.reference_errors).map(([p, e]) => `${p} (${e})`).join(", ")}
				</Text>
			)}
		</Modal>
	);
}
