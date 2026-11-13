import { useEffect, useRef } from "react";
import { Form, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { IAuditChecks } from "../../../types/auditChecks";
import { AUDIT_SECTIONS, auditSection, type AuditSectionId } from "../../../utils/auditChecks";
import { answersWithSave } from "../../../utils/auditPrefill";
import { nextStep, previousStep, type IAuditCheckView } from "./auditCheckView";
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
}

const ORDER: AuditSectionId[] = AUDIT_SECTIONS.map((s) => s.id);

/** Going through the audit one step at a time: Back and Next, moving on once the open step's
 * check is answered, and the keys: Enter takes the open step's suggestions as your answers and
 * moves on, Shift+Enter goes back, Ctrl+S saves the audit. */
export function useAuditStepper({ datasetId, checks, view, setView, disabled, openAnswered }: UseAuditStepperOptions) {
	const { user } = useAuth();
	const form = Form.useFormInstance();
	const { mutateAsync: saveAnswers } = useSaveAuditAnswers();

	const goTo = (id: AuditSectionId | null) => {
		setView({ section: id, cropId: null });
		// past the last step: back to the decision at the top, where the audit is saved
		if (id === null) document.querySelector('[data-testid="audit-decision"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
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
			Enter: disabled ? undefined : () => void accept(),
			"shift+Enter": view.section ? back(view.section) : undefined,
			"mod+s": () => form.submit(),
		},
		true,
	);

	return { goTo, next, back };
}
