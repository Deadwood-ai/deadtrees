import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Segmented, Select, Slider } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { Map as OLMap } from "ol";
import type BaseLayer from "ol/layer/Base";
import { auditImageUrl } from "../../../api/auditImages";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import type { IAuditCheckEvidence, IAuditImage } from "../../../types/auditChecks";
import type { IGeorefCheck } from "../../../types/georefCheck";
import { cropModelVerdict, orderedCrops, stepCrop, type CropImageKind, type IAuditSectionDef } from "../../../utils/auditChecks";
import { InlineLoadError, InlineSkeleton } from "../../SectionStates";
import { georefReferenceOptions, useGeorefLayers } from "./useGeorefLayers";
import { CROP_COLOR, useCropSquares, zoomToCrop } from "./useCropSquares";
import { useOrthoOnlyLayers } from "./useOrthoOnlyLayers";
import { modelViewImage } from "./auditCheckView";

/** What the audit map needs to show the open section's check. */
export interface IAuditCheckMapProps {
	section: IAuditSectionDef | null;
	georefCheck: IGeorefCheck | null;
	/** the open section's check results, when its check has run */
	evidence: IAuditCheckEvidence | undefined;
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
}

interface AuditCheckMapProps extends IAuditCheckMapProps {
	map: OLMap | null;
	orthoLayer: BaseLayer | null;
}

const VERDICT_COLORS = { major: "#ff9a3c", unsure: "#ffd27a", minor: "#ffd27a", ok: CROP_COLOR };
const IMAGE_LABELS: Record<CropImageKind, string> = { raw: "Raw", deadwood_overlay: "Deadwood", forest_cover_overlay: "Forest" };

/** Puts the audit map into the open section's mode (reference and match lines, or the
 * judged crops) and shows the mode's controls, including what the model saw. The controls'
 * settings live here and start afresh with each section (the parent keys this by section). */
export default function AuditCheckMap({ map, orthoLayer, section, georefCheck, evidence, cropId, onSelectCrop }: AuditCheckMapProps) {
	const mode = section?.map ?? null;
	const cropMode = mode?.kind === "crops" ? mode : null;
	const [provider, setProvider] = useState<string>();
	const [showMatches, setShowMatches] = useState(true);
	const [droneOpacity, setDroneOpacity] = useState(60);
	const [colorByVerdict, setColorByVerdict] = useState(false);
	const [showModelView, setShowModelView] = useState(false);
	const [imageKind, setImageKind] = useState<CropImageKind>("raw");

	const georef = mode?.kind === "georef" ? georefCheck : null;
	const references = useMemo(() => (georef ? georefReferenceOptions(georef) : []), [georef]);
	const shownProvider = provider ?? references[0]?.value;
	// keyed on the rows, not the evidence object: an answer must not rebuild the squares or move the map
	const cropRows = evidence?.crops;
	const automated = evidence?.automated;
	const crops = useMemo(() => (cropMode && cropRows?.length ? orderedCrops({ crops: cropRows }) : null), [cropMode, cropRows]);
	const colorLayers = cropMode?.colorLayers;
	const colors = useMemo(() => {
		if (!crops || !colorByVerdict || !colorLayers?.length) return undefined;
		return Object.fromEntries(crops.map((c) => [c.id, VERDICT_COLORS[cropModelVerdict({ automated: automated ?? [] }, c.id, colorLayers) ?? "ok"]]));
	}, [crops, colorByVerdict, colorLayers, automated]);

	useOrthoOnlyLayers(!!cropMode?.orthoOnly);
	useGeorefLayers({ map, orthoLayer, check: georef, provider: shownProvider, showMatches, droneOpacity });
	useCropSquares({ map, crops, selectedId: cropId, colors, onSelect: onSelectCrop });

	const index = crops ? crops.findIndex((c) => c.id === cropId) : -1;
	useEffect(() => {
		if (index >= 0) zoomToCrop(map, crops?.[index]);
	}, [map, crops, index]);

	const step = (by: 1 | -1) => {
		const next = stepCrop(crops ?? [], cropId, by);
		if (next !== null) onSelectCrop(next);
	};

	if (!section || !mode) return null;
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
			{cropMode && crops && (
				<>
					<div className="flex items-center justify-between">
						<Button size="small" icon={<LeftOutlined />} aria-label="Previous crop" onClick={() => step(-1)} />
						<span>{index >= 0 ? `Crop ${index + 1} of ${crops.length}` : `${crops.length} crops · click one`}</span>
						<Button size="small" icon={<RightOutlined />} aria-label="Next crop" onClick={() => step(1)} />
					</div>
					{cropMode.colorLayers.length > 0 && (
						<Checkbox checked={colorByVerdict} onChange={(e) => setColorByVerdict(e.target.checked)}>
							Colour squares by model verdict
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
						<Segmented
							size="small"
							block
							value={imageKind}
							options={cropMode.images.map((kind) => ({ label: IMAGE_LABELS[kind], value: kind }))}
							onChange={(v) => setImageKind(v as CropImageKind)}
						/>
					)}
					<ModelImage image={modelViewImage(evidence, cropId, imageKind)} hasCrop={cropId !== null} />
				</>
			)}
		</div>
	);
}

function ModelImage({ image, hasCrop }: { image: IAuditImage | null; hasCrop: boolean }) {
	if (!image) return <div className="text-gray-500">{hasCrop ? "No stored image for this crop." : "No stored overview; pick a crop."}</div>;
	return <SignedImage image={image} />;
}

/** One stored image behind the auditors' signed link; mounting it is what asks for the ticket. */
function SignedImage({ image }: { image: IAuditImage }) {
	const access = useAuditImageAccess();
	if (access.isError) return <InlineLoadError message="The images couldn’t load." onRetry={() => void access.refetch()} />;
	if (!access.data) return <InlineSkeleton label="Loading the model's image" className="aspect-square w-full" />;
	return (
		<img
			src={auditImageUrl(access.data, image.storage_path)}
			alt={`What the model saw: ${image.kind.replace(/_/g, " ")}`}
			className="h-auto w-full rounded border border-gray-200"
			width={image.width}
			height={image.height}
		/>
	);
}
