import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Segmented, Select, Slider } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { Map as OLMap } from "ol";
import type BaseLayer from "ol/layer/Base";
import type { IAuditCheckEvidence, IAuditImage } from "../../../types/auditChecks";
import type { IGeorefCheck } from "../../../types/georefCheck";
import { stepCrop, type CropImageKind, type IAuditSectionDef } from "../../../utils/auditChecks";
import { cropCalls, cropsForReview } from "../../../utils/cropCalls";
import CropImage from "../review/CropImage";
import AuditCropReview, { type AuditCropReviewProps } from "./AuditCropReview";
import { georefReferenceOptions, useGeorefLayers } from "./useGeorefLayers";
import { useCropSquares, zoomToCrop } from "./useCropSquares";
import { useSectionLayers } from "./useSectionLayers";
import { useAuditShortcuts } from "./useAuditShortcuts";
import { useDatasetDetailsMap } from "../../../hooks/useDatasetDetailsMapProvider";
import { canReviewCrops, cropReviewOpen, modelViewImage } from "./auditCheckView";

/** What the audit map needs to show the open section's check. */
export interface IAuditCheckMapProps {
	section: IAuditSectionDef | null;
	georefCheck: IGeorefCheck | null;
	/** the open section's check results, when its check has run */
	evidence: IAuditCheckEvidence | undefined;
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	/** the crop review of a prediction step: where answers go, and the map instead of the crops (M) */
	cropReview: Pick<AuditCropReviewProps, "datasetId" | "people" | "disabled" | "onNextStep"> & {
		mapOnly: boolean;
		setMapOnly: (mapOnly: boolean) => void;
	};
}

interface AuditCheckMapProps extends IAuditCheckMapProps {
	map: OLMap | null;
	orthoLayer: BaseLayer | null;
}

const IMAGE_LABELS: Record<CropImageKind, string> = { raw: "Raw", deadwood_overlay: "Deadwood", forest_cover_overlay: "Forest" };

/** Puts the audit map into the open section's mode (reference and match lines, or the
 * judged crops) and shows the mode's controls, including what the model saw. The controls'
 * settings live here and start afresh with each section (the parent keys this by section). */
export default function AuditCheckMap({ map, orthoLayer, section, georefCheck, evidence, cropId, onSelectCrop, cropReview }: AuditCheckMapProps) {
	const mode = section?.map ?? null;
	const cropMode = mode?.kind === "crops" ? mode : null;
	const [provider, setProvider] = useState<string>();
	const [showMatches, setShowMatches] = useState(true);
	const [droneOpacity, setDroneOpacity] = useState(60);
	const [colorByVerdict, setColorByVerdict] = useState(true);
	const [showModelView, setShowModelView] = useState(!!(section?.map?.kind === "crops" && section.map.showModelView));
	// the step's own layer first: what the model saw of that prediction
	const [imageKind, setImageKind] = useState<CropImageKind>(section?.map?.kind === "crops" ? section.map.images[0] : "raw");

	const georef = mode?.kind === "georef" ? georefCheck : null;
	const references = useMemo(() => (georef ? georefReferenceOptions(georef) : []), [georef]);
	const shownProvider = provider ?? references[0]?.value;
	// keyed on the rows, not the evidence object: an answer must not rebuild the squares or move the map
	const cropRows = evidence?.crops;
	const automated = evidence?.automated;
	const run = evidence?.run;
	const colorLayers = cropMode?.colorLayers;
	// the same calls and order the crop answers use: the crops the check counted major first
	const calls = useMemo(
		() => (cropMode && run && cropRows?.length ? cropCalls({ run, automated: automated ?? [], crops: cropRows }, colorLayers ?? []) : null),
		[cropMode, run, automated, cropRows, colorLayers],
	);
	const crops = useMemo(() => (calls && cropRows ? cropsForReview({ crops: cropRows }, calls) : null), [calls, cropRows]);
	const flagged = useMemo(
		() => (calls && colorByVerdict ? new Set([...calls].filter(([, call]) => call === "major").map(([id]) => id)) : undefined),
		[calls, colorByVerdict],
	);

	useSectionLayers(section?.shows ?? null);

	// T switches raw image and prediction at once: the crop view of what the model saw and the
	// step's prediction layer on the map
	const { layerControl, setShowDeadwood, setShowForestCover } = useDatasetDetailsMap();
	const overlay = cropMode?.images.find((kind) => kind !== "raw");
	const togglePrediction = () => {
		if (!overlay || !section?.shows) return;
		const showing = imageKind !== "raw";
		setShowModelView(true);
		setImageKind(showing ? "raw" : overlay);
		if (section.shows.deadwood) setShowDeadwood(!showing);
		if (section.shows.forestCover) setShowForestCover(!showing);
	};
	const reviewing = cropReviewOpen(cropReview, section, evidence);
	// on the map, T switches the prediction and M goes back to the crop review
	useAuditShortcuts(
		{ t: overlay ? togglePrediction : undefined, m: canReviewCrops(section, evidence) ? () => cropReview.setMapOnly(false) : undefined },
		!!cropMode && !reviewing,
	);
	const predictionShown = section?.shows?.deadwood ? layerControl.showDeadwood : section?.shows?.forestCover ? layerControl.showForestCover : false;
	useGeorefLayers({ map, orthoLayer, check: georef, provider: shownProvider, showMatches, droneOpacity });
	useCropSquares({ map, crops, selectedId: cropId, flagged, onSelect: onSelectCrop });

	const index = crops ? crops.findIndex((c) => c.id === cropId) : -1;
	// the map follows the crop only while you see it: back on the map (M) it zooms to the current one
	useEffect(() => {
		if (index >= 0 && !reviewing) zoomToCrop(map, crops?.[index]);
	}, [map, crops, index, reviewing]);

	const step = (by: 1 | -1) => {
		const next = stepCrop(crops ?? [], cropId, by);
		if (next !== null) onSelectCrop(next);
	};

	if (!section || !mode) return null;
	if (reviewing && evidence) {
		return (
			<div className="pointer-events-auto absolute bottom-6 left-3 right-4 top-24 z-50 flex rounded-xl bg-white p-3 shadow-xl md:left-[calc(420px+2rem)]">
				<AuditCropReview
					{...cropReview}
					section={section}
					evidence={evidence}
					cropId={cropId}
					onSelectCrop={onSelectCrop}
					onShowMap={() => cropReview.setMapOnly(true)}
				/>
			</div>
		);
	}
	return (
		<div className="pointer-events-auto absolute bottom-6 left-3 z-50 flex max-h-[70vh] w-72 flex-col gap-2 overflow-y-auto rounded-xl bg-white/95 p-3 text-xs shadow-lg backdrop-blur-sm md:left-[calc(420px+2rem)]">
			<div className="text-sm font-semibold">
				Map mode: {section.title}
				{cropMode ? " crops" : ""}
			</div>
			{mode.kind === "georef" && !georef && <div className="text-gray-500">No georeferencing check to show.</div>}
			{georef && (
				<>
					<label className="flex flex-col gap-1">
						Reference
						<Select size="small" value={shownProvider} onChange={setProvider} options={references} popupMatchSelectWidth={false} />
					</label>
					{shownProvider && !references.find((r) => r.value === shownProvider)?.hasImagery && (
						<div className="text-gray-500">This reference's imagery cannot be shown; its matches are drawn.</div>
					)}
					<Checkbox checked={showMatches} onChange={(e) => setShowMatches(e.target.checked)}>
						Match lines
					</Checkbox>
					<label className="flex items-center gap-2">
						Drone opacity
						<Slider className="flex-1" min={0} max={100} value={droneOpacity} onChange={setDroneOpacity} />
					</label>
					<div className="text-[11px] text-gray-500">Green under 7.5 m, amber under 15 m, red over; grey matches were rejected by the fit.</div>
					{Object.keys(georef.reference_errors).length > 0 && (
						<div className="text-[11px] text-gray-500">
							Unavailable: {Object.entries(georef.reference_errors).map(([p, e]) => `${p} (${e})`).join(", ")}
						</div>
					)}
				</>
			)}
			{cropMode && !crops && <div className="text-gray-500">This check has no stored crops yet.</div>}
			{canReviewCrops(section, evidence) && (
				<Button size="small" type="primary" onClick={() => cropReview.setMapOnly(false)}>
					Back to the crop review (M)
				</Button>
			)}
			{cropMode && crops && (
				<>
					<div className="flex items-center justify-between">
						<Button size="small" icon={<LeftOutlined />} aria-label="Previous crop" onClick={() => step(-1)} />
						<span>{index >= 0 ? `Crop ${index + 1} of ${crops.length}` : `${crops.length} crops · click one`}</span>
						<Button size="small" icon={<RightOutlined />} aria-label="Next crop" onClick={() => step(1)} />
					</div>
					{cropMode.colorLayers.length > 0 && (
						<Checkbox checked={colorByVerdict} onChange={(e) => setColorByVerdict(e.target.checked)}>
							Mark the crops the check counted major (orange, dashed, "!")
						</Checkbox>
					)}
				</>
			)}
			{cropMode && (
				<Checkbox className="border-t border-gray-100 pt-2" checked={showModelView} onChange={(e) => setShowModelView(e.target.checked)}>
					Show what the model saw
				</Checkbox>
			)}
			{cropMode && showModelView && (
				<>
					{cropMode.images.length > 1 && cropId !== null && (
						<>
							<Segmented
								size="small"
								block
								value={imageKind}
								options={cropMode.images.map((kind) => ({ label: IMAGE_LABELS[kind], value: kind }))}
								onChange={(v) => setImageKind(v as CropImageKind)}
							/>
							<div className="text-[11px] text-gray-500">
								T: raw or prediction, here and on the map (map prediction {predictionShown ? "on" : "off"})
							</div>
						</>
					)}
					<ModelImage image={modelViewImage(evidence, cropId, imageKind)} hasCrop={cropId !== null} />
				</>
			)}
		</div>
	);
}

function ModelImage({ image, hasCrop }: { image: IAuditImage | null; hasCrop: boolean }) {
	if (!image) return <div className="text-gray-500">{hasCrop ? "No stored image for this crop." : "No stored overview; pick a crop."}</div>;
	return <CropImage image={image} />;
}
