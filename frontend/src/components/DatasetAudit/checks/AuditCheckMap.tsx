import { useEffect, useMemo } from "react";
import { Button, Checkbox, Segmented, Select, Slider } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type { Map as OLMap } from "ol";
import type BaseLayer from "ol/layer/Base";
import { auditImageUrl } from "../../../api/auditImages";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import { cropModelVerdict, orderedCrops } from "../../../utils/auditChecks";
import { InlineLoadError, InlineSkeleton } from "../../SectionStates";
import { georefReferenceOptions, useGeorefLayers } from "./useGeorefLayers";
import { CROP_COLOR, useCropSquares, zoomToCrop } from "./useCropSquares";
import { modelViewImage, type CropImageKind, type IAuditCheckMapProps } from "./auditCheckView";

interface AuditCheckMapProps extends IAuditCheckMapProps {
	map: OLMap | null;
	orthoLayer: BaseLayer | null;
}

const MODE_NAMES = { default: "Default", georef: "Georeferencing", evaluation: "Evaluation crops", prediction: "Prediction quality crops" };
const VERDICT_COLORS = { major: "#ff9a3c", unsure: "#ffd27a", minor: "#ffd27a", ok: CROP_COLOR };
const IMAGE_KINDS: { label: string; value: CropImageKind }[] = [
	{ label: "Raw", value: "raw" },
	{ label: "Deadwood", value: "deadwood_overlay" },
	{ label: "Forest", value: "forest_cover_overlay" },
];

/** Puts the audit map into the open section's mode (reference and match lines, or the
 * judged crops) and shows the mode's controls, including what the model saw. */
export default function AuditCheckMap({ map, orthoLayer, mode, georefCheck, evidence, view, setView }: AuditCheckMapProps) {
	const isGeoref = mode === "georef" && !!georefCheck;
	const isCrops = (mode === "evaluation" || mode === "prediction") && !!evidence?.crops.length;
	const crops = useMemo(() => (isCrops ? orderedCrops(evidence) : null), [isCrops, evidence]);
	const references = useMemo(() => (georefCheck ? georefReferenceOptions(georefCheck) : []), [georefCheck]);
	const provider = view.provider ?? references[0]?.value;
	const colors = useMemo(() => {
		if (!crops || !view.colorByVerdict || mode !== "prediction") return undefined;
		return Object.fromEntries(
			crops.map((c) => [c.id, VERDICT_COLORS[cropModelVerdict(evidence, c.id, ["deadwood", "forest_cover"]) ?? "ok"]]),
		);
	}, [crops, view.colorByVerdict, mode, evidence]);

	useGeorefLayers({
		map,
		orthoLayer,
		check: isGeoref ? georefCheck : null,
		provider,
		showMatches: view.showMatches,
		droneOpacity: view.droneOpacity,
	});
	useCropSquares({ map, crops, selectedId: view.cropId, colors, onSelect: (cropId) => setView({ cropId }) });

	const index = crops ? crops.findIndex((c) => c.id === view.cropId) : -1;
	useEffect(() => {
		if (index >= 0) zoomToCrop(map, crops?.[index]);
	}, [map, crops, index]);

	const step = (by: number) => {
		if (!crops?.length) return;
		const next = crops[(Math.max(index, by > 0 ? -1 : 0) + by + crops.length) % crops.length];
		setView({ cropId: next.id });
	};

	if (mode === "default") return null;
	return (
		<div className="pointer-events-auto absolute bottom-6 left-3 z-50 flex max-h-[70vh] w-72 flex-col gap-2 overflow-y-auto rounded-xl bg-white/95 p-3 text-xs shadow-lg backdrop-blur-sm md:left-[calc(420px+2rem)]">
			<div className="text-sm font-semibold">Map mode: {MODE_NAMES[mode]}</div>
			{mode === "georef" && !georefCheck && <div className="text-gray-500">No georeferencing check to show.</div>}
			{isGeoref && (
				<>
					<label className="flex flex-col gap-1">
						Reference
						<Select
							size="small"
							value={provider}
							onChange={(value) => setView({ provider: value })}
							options={references}
							popupMatchSelectWidth={false}
						/>
					</label>
					{provider && !references.find((r) => r.value === provider)?.hasImagery && (
						<div className="text-gray-500">This reference's imagery cannot be shown; its matches are drawn.</div>
					)}
					<Checkbox checked={view.showMatches} onChange={(e) => setView({ showMatches: e.target.checked })}>
						Match lines
					</Checkbox>
					<label className="flex items-center gap-2">
						Drone opacity
						<Slider className="flex-1" min={0} max={100} value={view.droneOpacity} onChange={(v) => setView({ droneOpacity: v })} />
					</label>
					<div className="text-[11px] text-gray-500">Green under 7.5 m, amber under 15 m, red over; grey matches were rejected by the fit.</div>
					{Object.keys(georefCheck.reference_errors).length > 0 && (
						<div className="text-[11px] text-gray-500">
							Unavailable: {Object.entries(georefCheck.reference_errors).map(([p, e]) => `${p} (${e})`).join(", ")}
						</div>
					)}
				</>
			)}
			{(mode === "evaluation" || mode === "prediction") && !isCrops && <div className="text-gray-500">This check has no stored crops yet.</div>}
			{isCrops && crops && (
				<>
					<div className="flex items-center justify-between">
						<Button size="small" icon={<LeftOutlined />} aria-label="Previous crop" onClick={() => step(-1)} />
						<span>{index >= 0 ? `Crop ${index + 1} of ${crops.length}` : `${crops.length} crops · click one`}</span>
						<Button size="small" icon={<RightOutlined />} aria-label="Next crop" onClick={() => step(1)} />
					</div>
					{mode === "prediction" && (
						<Checkbox checked={view.colorByVerdict} onChange={(e) => setView({ colorByVerdict: e.target.checked })}>
							Colour squares by model verdict
						</Checkbox>
					)}
				</>
			)}
			{(mode === "evaluation" || mode === "prediction") && (
				<Checkbox
					className="border-t border-gray-100 pt-2"
					checked={view.showModelView}
					onChange={(e) => setView({ showModelView: e.target.checked })}
				>
					Show what the model saw
				</Checkbox>
			)}
			{view.showModelView && (mode === "evaluation" || mode === "prediction") && (
				<ModelView evidence={evidence} view={view} setView={setView} prediction={mode === "prediction"} />
			)}
		</div>
	);
}

function ModelView({ evidence, view, setView, prediction }: Pick<IAuditCheckMapProps, "evidence" | "view" | "setView"> & { prediction: boolean }) {
	const access = useAuditImageAccess(true);
	const image = modelViewImage(evidence, view);
	return (
		<div className="flex flex-col gap-1.5">
			{prediction && view.cropId !== null && (
				<Segmented size="small" block value={view.imageKind} options={IMAGE_KINDS} onChange={(v) => setView({ imageKind: v as CropImageKind })} />
			)}
			{!image ? (
				<div className="text-gray-500">{view.cropId === null ? "No stored overview; pick a crop." : "No stored image for this crop."}</div>
			) : access.isError ? (
				<InlineLoadError message="The images couldn’t load." onRetry={() => access.refetch()} />
			) : !access.data ? (
				<InlineSkeleton label="Loading the model's image" className="aspect-square w-full" />
			) : (
				<img
					src={auditImageUrl(access.data, image.storage_path)}
					alt={`What the model saw: ${image.kind.replace(/_/g, " ")}`}
					className="h-auto w-full rounded border border-gray-200"
					width={image.width}
					height={image.height}
				/>
			)}
		</div>
	);
}
