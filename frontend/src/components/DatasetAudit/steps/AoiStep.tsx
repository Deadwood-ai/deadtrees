import type { ComponentProps } from "react";
import type { IAuditDatasetResult } from "../../../types/auditChecks";
import AuditAOICard from "../AuditAOICard";

const SOURCES: Record<string, string> = {
	ml_prediction: "Model prediction",
	manual: "Drawn by hand",
	manual_correction: "Corrected by hand",
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");

interface AoiStepProps {
	result: IAuditDatasetResult | null | undefined;
	editor: ComponentProps<typeof AuditAOICard>;
}

/** Step 2: the area of interest as stored (exists, created, source, model version), and its
 * editing on the map. A dataset whose processing finished without an AOI needs one drawn. */
export default function AoiStep({ result, editor }: AoiStepProps) {
	const rows: [string, string][] = [
		["Exists", result?.aoi_exists ? "Yes" : "No"],
		["Created", day(result?.aoi_created_at)],
		["Source", result?.aoi_source ? (SOURCES[result.aoi_source] ?? result.aoi_source) : "–"],
		["Model version", result?.aoi_model_version ?? "–"],
	];
	return (
		<div className="flex flex-col gap-2" data-testid="audit-aoi-step">
			<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
				{rows.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-gray-500">{label}</dt>
						<dd className="m-0">{value}</dd>
					</div>
				))}
			</dl>
			<div className="text-xs text-gray-600">Edit the area of interest on the map. The later checks run inside it.</div>
			<AuditAOICard {...editor} />
		</div>
	);
}
