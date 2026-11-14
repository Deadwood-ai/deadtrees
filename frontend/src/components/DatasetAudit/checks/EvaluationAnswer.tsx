import { useState } from "react";
import { Button, Checkbox, Form, Input, Tag, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import {
	EVALUATION_FLAGS,
	auditSection,
	automatedRows,
	automatedVerdict,
	evaluationAnswerText,
	evaluationFlags,
	keepsDataset,
	myAnswer,
	type EvaluationFlag,
} from "../../../utils/auditChecks";
import { REPROCESS_DRAFT, evaluationDraft } from "../../../utils/auditPrefill";
import { useAuditShortcuts } from "./useAuditShortcuts";
import AddToBenchmarkButton from "../benchmark/AddToBenchmarkButton";

interface EvaluationAnswerProps {
	datasetId: number;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	/** no audit lease on this page: answers cannot be stored */
	disabled: boolean;
	/** the step is open: only then do K (keep) and X (exclude) answer it */
	active: boolean;
}

const LAYER = "image" as const;
const SECTION = auditSection("evaluation");
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The two lines of a Keep or Exclude button: the call and whether it agrees with the check. */
const CallLabel = ({ title, hint }: { title: string; hint: string }) => (
	<span className="flex flex-col items-center leading-tight">
		<span className="font-semibold">{title}</span>
		<span className="text-[11px] text-gray-500">{hint}</span>
	</span>
);

/** Step 1 asks one thing: keep the dataset or exclude it. One click answers it; picking what
 * the check said is agreeing, picking the other is disagreeing. Excluding needs the reason. A
 * kept dataset can carry two flags, a COG issue and a thumbnail issue, preset from the check.
 * Every answer is a new person row on the current run. */
export default function EvaluationAnswer({ datasetId, evidence, people, disabled, active }: EvaluationAnswerProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const runId = evidence.run.id;
	const target = { checkKey: "dataset_evaluation" as const, layer: LAYER };
	const verdict = automatedVerdict(evidence, LAYER);
	const rows = automatedRows(evidence, LAYER);
	const rule = rows[0];
	const mine = myAnswer(people, user?.id, runId, target);

	const [changing, setChanging] = useState(false);
	const [excluding, setExcluding] = useState(false);
	const [reason, setReason] = useState<string | null>(verdict === "major" ? text(rule?.details.reason) : null);
	const [note, setNote] = useState("");
	// the flags before an answer live in the form, so Keep, Enter and saving the audit all read the
	// same draft: the COG and thumbnail fields (prefilled from the check where the saved audit is
	// empty) and the reprocessing draft
	const form = Form.useFormInstance();
	const values = Form.useWatch((v) => v, { form, preserve: true }) ?? {};
	const draft = evaluationDraft(values, rule?.details);
	const setDraft = (next: EvaluationFlag[]) =>
		form.setFieldsValue(
			Object.fromEntries(EVALUATION_FLAGS.map(({ flag, field }) => [field ?? REPROCESS_DRAFT, next.includes(flag)])),
		);

	const answered = !!mine && !changing;
	const flags = answered ? evaluationFlags(mine) : draft;

	const store = async (answer: AuditVerdict, fixFlags: EvaluationFlag[], reasonCode: string | null = null, reasonText: string | null = null) => {
		try {
			await save([
				{
					check_key: "dataset_evaluation",
					dataset_id: datasetId,
					run_id: runId,
					layer: LAYER,
					verdict: answer,
					reason_code: reasonCode,
					reason_text: reasonText?.trim() || null,
					details: { fix_flags: fixFlags },
				},
			]);
			setChanging(false);
			setExcluding(false);
			setNote("");
		} catch {
			message.error("Your answer was not saved. Please try again.");
		}
	};
	const keep = (fixFlags: EvaluationFlag[]) => store(fixFlags.length ? "minor" : "ok", fixFlags);
	// K keeps, X opens the exclude reasons, while the step is open and not yet answered
	const ready = !answered && !excluding && !disabled && !isPending;
	useAuditShortcuts(ready ? { k: () => void keep(draft), x: () => setExcluding(true) } : {}, active);

	const toggle = (flag: EvaluationFlag) => {
		const next = flags.includes(flag) ? flags.filter((f) => f !== flag) : [...flags, flag];
		// a flag changed after the answer is part of the answer: it is stored at once
		if (answered) void keep(next);
		else setDraft(next);
	};

	const checkSays = !verdict ? "The check made no call." : verdict === "unsure" || !rule ? "The check could not decide." : `The check says ${evaluationAnswerText({ ...rule, verdict })}.`;
	const agrees = (answer: "keep" | "exclude") => (answer === "keep" ? keepsDataset(verdict) : verdict === "major");
	const decided = keepsDataset(verdict) || verdict === "major";
	// the check's call is preselected: saving the audit takes it over unless you pick the other
	const suggested = (answer: "keep" | "exclude") => (decided && agrees(answer) ? ("primary" as const) : undefined);
	const hint = (answer: "keep" | "exclude") =>
		decided ? (agrees(answer) ? "suggested by the check" : "the check is wrong") : answer === "keep" ? "the orthophoto is usable" : "the orthophoto is unusable";
	const myCall = mine ? (keepsDataset(mine.verdict) ? "keep" : "exclude") : null;
	const describe = (a: IAuditAssessment) => `${evaluationAnswerText(a)}${a.reason_text ? `, “${a.reason_text}”` : ""}`;

	return (
		<div className="mb-3 flex flex-col gap-3" data-testid="audit-evaluation-answer">
			<div className="text-xs text-gray-700">
				<b>{checkSays}</b> {text(rule?.details.summary)}
			</div>
			<AddToBenchmarkButton checkKey="dataset_evaluation" datasetId={datasetId} active={active} />

			{answered ? (
				<div className="flex flex-col gap-1 rounded-md bg-white px-2.5 py-2 text-xs">
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<span>
							You: <b>{describe(mine)}</b>
							{decided && (agrees(myCall!) ? ", as the check says" : `, the check said ${verdict === "major" ? "exclude" : "keep"}`)}
						</span>
						<Button
							size="small"
							type="link"
							className="p-0 text-xs"
							disabled={disabled}
							onClick={() => {
								// changing starts from the answer, not from what the check said
								setDraft(evaluationFlags(mine));
								setChanging(true);
							}}
						>
							Change
						</Button>
					</div>
				</div>
			) : excluding ? (
				<div className="flex flex-col gap-2 rounded-md border border-red-100 bg-white p-2">
					<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Why exclude</div>
					<div className="flex flex-wrap gap-1.5">
						{SECTION.reasons.map((r) => (
							<Tag.CheckableTag key={r.code} checked={reason === r.code} onChange={() => setReason(r.code)}>
								{r.label}
							</Tag.CheckableTag>
						))}
					</div>
					<Input size="small" placeholder="Note (optional)" aria-label="Note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
					<div className="flex items-center gap-3">
						<Button size="small" danger type="primary" disabled={disabled || !reason} loading={isPending} onClick={() => reason && store("major", [], reason, note)}>
							Save: Exclude
						</Button>
						<Button size="small" type="link" className="p-0 text-xs" onClick={() => setExcluding(false)}>
							Back
						</Button>
					</div>
				</div>
			) : (
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Your call</div>
					<div className="flex gap-2">
						<Button className="!h-auto flex-1 !py-1.5" type={suggested("keep")} ghost={!!suggested("keep")} disabled={disabled || isPending} onClick={() => keep(draft)}>
							<CallLabel title="Keep" hint={hint("keep")} />
						</Button>
						<Button className="!h-auto flex-1 !py-1.5" type={suggested("exclude")} ghost={!!suggested("exclude")} danger={!!suggested("exclude")} disabled={disabled || isPending} onClick={() => setExcluding(true)}>
							<CallLabel title="Exclude" hint={hint("exclude")} />
						</Button>
					</div>
				</div>
			)}

			{!excluding && myCall !== "exclude" && (
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Problems to fix, if any</div>
					<div className="flex flex-wrap gap-1.5">
						{EVALUATION_FLAGS.map(({ flag, label }) => (
							<Checkbox key={flag} checked={flags.includes(flag)} disabled={disabled || isPending} onChange={() => toggle(flag)}>
								{label}
							</Checkbox>
						))}
					</div>
					{EVALUATION_FLAGS.filter((f) => f.notes && flags.includes(f.flag)).map(({ flag, notes, inText }) => (
						<Form.Item key={flag} name={notes} className="mb-0 mt-1.5">
							<Input size="small" placeholder={`What is the ${inText}?`} aria-label={`Note on the ${inText}`} maxLength={2000} />
						</Form.Item>
					))}
				</div>
			)}

		</div>
	);
}
