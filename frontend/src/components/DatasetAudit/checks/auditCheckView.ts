import type { IAuditCheckEvidence, IAuditImage } from "../../../types/auditChecks";
import { AUDIT_SECTIONS, type AuditSectionId, type CropImageKind, type IAuditSectionDef } from "../../../utils/auditChecks";

/** What the reviewer looks at: the open section and, where it shows crops, the selected one. A
 * prediction step shows its crops in the crop review over the map until you ask for the map (M). */
export interface IAuditCheckView {
	section: AuditSectionId | null;
	cropId: number | null;
	mapOnly: boolean;
}

export const INITIAL_CHECK_VIEW: IAuditCheckView = { section: null, cropId: null, mapOnly: false };

/** The crop review covers the map: the open step answers per crop, its check stored crops, and
 * you did not ask for the map. Its own keys then replace the steps' Enter. */
export const cropReviewOpen = (view: Pick<IAuditCheckView, "mapOnly">, section: IAuditSectionDef | null, evidence: IAuditCheckEvidence | undefined) =>
	!!section?.cropAnswers && !!evidence?.crops.length && !view.mapOnly;

/** The stored image the model saw: the selected crop's (falling back to its raw image), else the dataset overview. */
export function modelViewImage(evidence: IAuditCheckEvidence | undefined, cropId: number | null, kind: CropImageKind): IAuditImage | null {
	const images = evidence?.images ?? [];
	if (cropId !== null) {
		return images.find((i) => i.crop_id === cropId && i.kind === kind) ?? images.find((i) => i.crop_id === cropId && i.kind === "raw") ?? null;
	}
	return images.find((i) => i.kind === "overview") ?? images.find((i) => i.kind === "thumbnail") ?? null;
}

/** The audit's steps in order. */
export const STEP_ORDER: AuditSectionId[] = AUDIT_SECTIONS.map((s) => s.id);

/** Opens a step, or past the last one goes back to the decision at the top, where the audit is saved. */
export function openStep(setView: (patch: Partial<IAuditCheckView>) => void, id: AuditSectionId | null) {
	setView({ section: id, cropId: null, mapOnly: false });
	if (id === null) document.querySelector('[data-testid="audit-decision"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
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
