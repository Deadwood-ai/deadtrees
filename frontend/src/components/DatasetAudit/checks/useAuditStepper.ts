import { Form } from "antd";
import { type AuditSectionId } from "../../../utils/auditChecks";
import { STEP_ORDER, nextStep, openStep, previousStep, type IAuditCheckView } from "./auditCheckView";
import { useAuditShortcuts } from "./useAuditShortcuts";

interface UseAuditStepperOptions {
	view: IAuditCheckView;
	setView: (patch: Partial<IAuditCheckView>) => void;
	/** the crop review is open: Enter is its key */
	cropReview: boolean;
}

/** Going through the review one step at a time: Next, and the keys: Enter opens the next step,
 * Shift+Enter goes back, Ctrl+S saves. */
export function useAuditStepper({ view, setView, cropReview }: UseAuditStepperOptions) {
	const form = Form.useFormInstance();
	const goTo = (id: AuditSectionId | null) => openStep(setView, id);
	const next = (id: AuditSectionId) => nextStep(STEP_ORDER, id);
	const before = view.section ? previousStep(STEP_ORDER, view.section) : null;

	useAuditShortcuts(
		{
			Enter: cropReview ? undefined : () => goTo(view.section ? next(view.section) : STEP_ORDER[0]),
			"shift+Enter": before ? () => goTo(before) : undefined,
			"mod+s": () => form.submit(),
		},
		true,
	);

	return { goTo, next };
}
