import type { IAuditCheckEvidence, IAuditImage } from "../../../types/auditChecks";
import type { AuditSectionId, CropImageKind } from "../../../utils/auditChecks";

/** What the reviewer looks at: the open section and, where it shows crops, the selected one. */
export interface IAuditCheckView {
	section: AuditSectionId | null;
	cropId: number | null;
}

export const INITIAL_CHECK_VIEW: IAuditCheckView = { section: null, cropId: null };

/** The stored image the model saw: the selected crop's (falling back to its raw image), else the dataset overview. */
export function modelViewImage(evidence: IAuditCheckEvidence | undefined, cropId: number | null, kind: CropImageKind): IAuditImage | null {
	const images = evidence?.images ?? [];
	if (cropId !== null) {
		return images.find((i) => i.crop_id === cropId && i.kind === kind) ?? images.find((i) => i.crop_id === cropId && i.kind === "raw") ?? null;
	}
	return images.find((i) => i.kind === "overview") ?? images.find((i) => i.kind === "thumbnail") ?? null;
}

/** The step after `current`, or null after the last one. The audit goes through every step
 * in order, the ones without a check too: they are answered by hand. */
export function nextStep(order: AuditSectionId[], current: AuditSectionId): AuditSectionId | null {
	return order[order.indexOf(current) + 1] ?? null;
}

/** The step before `current`, or null at the first one. */
export function previousStep(order: AuditSectionId[], current: AuditSectionId): AuditSectionId | null {
	return order[order.indexOf(current) - 1] ?? null;
}
