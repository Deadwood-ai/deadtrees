import { useEffect, useRef } from "react";
import { Form, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { IAuditChecks } from "../../../types/auditChecks";
import { auditSection, type AuditSectionId } from "../../../utils/auditChecks";
import { answersWithSave } from "../../../utils/auditPrefill";
import { STEP_ORDER, nextStep, openStep, previousStep, type IAuditCheckView } from "./auditCheckView";
import { useAuditShortcuts } from "./useAuditShortcuts";

interface UseAuditStepperOptions {
	datasetId: number;
	checks: IAuditChecks | undefined;
	view: IAuditCheckView;
	setView: (patch: Partial<IAuditCheckView>) => void;
	/** no audit lease: Enter cannot store answers */
	disabled: boolean;
	/** you answered every layer of the open step's check */
	openAnswered: boolean;
	/** the crop review is open: Enter is its key */
	cropReview: boolean;
}

const ORDER = STEP_ORDER;

/** Going through the audit one step at a time: Back and Next, moving on once the open step's
 * check is answered, and the keys: Enter takes the open step's suggestions as your answers and
 * moves on, Shift+Enter goes back, Ctrl+S saves the audit. */
export function useAuditStepper({ datasetId, checks, view, setView, disabled, openAnswered, cropReview }: UseAuditStepperOptions) {
	const { user } = useAuth();
	const form = Form.useFormInstance();
	const { mutateAsync: saveAnswers } = useSaveAuditAnswers();

	const goTo = (id: AuditSectionId | null) => openStep(setView, id);
	const next = (id: AuditSectionId) => nextStep(ORDER, id);
	const back = (id: AuditSectionId) => {
		const before = previousStep(ORDER, id);
		return before ? () => goTo(before) : undefined;
	};

	// an answer can come from any part of the step (its buttons, the crops, Enter): when the open
	// step's check becomes answered, move on
	const answeredBefore = useRef({ section: view.section, answered: openAnswered });
	useEffect(() => {
		const before = answeredBefore.current;
		answeredBefore.current = { section: view.section, answered: openAnswered };
		if (view.section && before.section === view.section && !before.answered && openAnswered) goTo(next(view.section));
	});

	const accept = async () => {
		const id = view.section;
		if (!id) return goTo(ORDER[0]);
		const { checkKey, layers } = auditSection(id);
		const answers = checkKey ? answersWithSave(checks, user?.id, form.getFieldsValue(true), datasetId, { only: checkKey, layers, withSave: false }) : [];
		if (!answers.length) return goTo(next(id));
		try {
			// a stored answer moves on by itself (above)
			await saveAnswers(answers);
		} catch {
			message.error("Your answer was not saved. Please try again.");
		}
	};

	useAuditShortcuts(
		{
			Enter: disabled || cropReview ? undefined : () => void accept(),
			"shift+Enter": view.section ? back(view.section) : undefined,
			"mod+s": () => form.submit(),
		},
		true,
	);

	return { goTo, next, back };
}
