import type { AuditImageKind, IAuditCheckEvidence, IAuditImage } from "../../../types/auditChecks";
import type { IGeorefCheck } from "../../../types/georefCheck";
import type { AuditMapMode, AuditSectionId } from "../../../utils/auditChecks";

export type CropImageKind = Extract<AuditImageKind, "raw" | "deadwood_overlay" | "forest_cover_overlay">;

/** What the reviewer looks at: the open section and its map mode's settings. */
export interface IAuditCheckView {
	section: AuditSectionId | null;
	/** georeferencing: the reference under the drone image */
	provider?: string;
	showMatches: boolean;
	droneOpacity: number;
	/** crop modes: the selected crop and which of its images to show */
	cropId: number | null;
	imageKind: CropImageKind;
	colorByVerdict: boolean;
	/** show the stored images the check judged */
	showModelView: boolean;
}

export const INITIAL_CHECK_VIEW: IAuditCheckView = {
	section: null,
	showMatches: true,
	droneOpacity: 60,
	cropId: null,
	imageKind: "raw",
	colorByVerdict: false,
	showModelView: false,
};

/** Everything the audit map needs to show the open section's check. */
export interface IAuditCheckMapProps {
	mode: AuditMapMode;
	georefCheck: IGeorefCheck | null;
	/** the check whose crops the map shows (evaluation or prediction quality) */
	evidence: IAuditCheckEvidence | undefined;
	view: IAuditCheckView;
	setView: (patch: Partial<IAuditCheckView>) => void;
}

/** The stored image for the current view: the selected crop's, else the dataset overview. */
export function modelViewImage(evidence: IAuditCheckEvidence | undefined, view: IAuditCheckView): IAuditImage | null {
	const images = evidence?.images ?? [];
	if (view.cropId !== null) {
		return (
			images.find((i) => i.crop_id === view.cropId && i.kind === view.imageKind) ??
			images.find((i) => i.crop_id === view.cropId && i.kind === "raw") ??
			null
		);
	}
	return images.find((i) => i.kind === "overview") ?? images.find((i) => i.kind === "thumbnail") ?? null;
}
