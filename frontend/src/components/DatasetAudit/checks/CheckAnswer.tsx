import { useState } from "react";
import { Button, Input, Space, Tag, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import {
	automatedRows,
	automatedVerdict,
	myAnswer,
	verdictLabel,
	type IAuditSectionDef,
} from "../../../utils/auditChecks";

interface CheckAnswerProps {
	datasetId: number;
	section: IAuditSectionDef;
	layer: AuditLayer;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	/** no audit lease on this page: answers cannot be stored */
	disabled: boolean;
}

/** One row of verdicts with the check's call marked as suggested: picking it agrees, picking
 * another asks for a fixed reason and a note. Left alone, saving the audit takes the
 * suggestion over. Every answer is a new person row on the current run. */
export default function CheckAnswer({ datasetId, section, layer, evidence, people, disabled }: CheckAnswerProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const [changing, setChanging] = useState(false);
	const [reason, setReason] = useState<string | null>(null);
	const [own, setOwn] = useState<AuditVerdict | null>(null);
	const [note, setNote] = useState("");

	const checkKey = section.checkKey!;
	const runId = evidence.run.id;
	const target = { checkKey, layer };
	const verdict = automatedVerdict(evidence, layer);
	const rows = automatedRows(evidence, layer);
	const mine = myAnswer(people, user?.id, runId, target);
	const decided = verdict !== null && verdict !== "unsure";
	const label = (v: AuditVerdict) => verdictLabel(checkKey, v);
	// a verdict other than the check's decided call is a disagreement: it needs a reason
	const pick = (choice: AuditVerdict) => (decided && choice !== verdict ? setOwn(choice) : void store(choice));

	const store = async (answer: AuditVerdict, reasonCode: string | null = null, reasonText: string | null = null) => {
		try {
			await save([
				{
					check_key: checkKey,
					dataset_id: datasetId,
					run_id: runId,
					layer,
					label_id: rows[0]?.label_id ?? null,
					verdict: answer,
					reason_code: reasonCode,
					reason_text: reasonText?.trim() || null,
				},
			]);
			setChanging(false);
			setReason(null);
			setOwn(null);
			setNote("");
		} catch {
			message.error("Your answer was not saved. Please try again.");
		}
	};

	const describe = (a: IAuditAssessment) =>
		a.reason_code
			? `Check wrong (${section.reasons.find((r) => r.code === a.reason_code)?.label ?? a.reason_code}): ${label(a.verdict)}${a.reason_text ? `, “${a.reason_text}”` : ""}`
			: a.verdict === verdict
				? `Agree (${label(a.verdict)})`
				: label(a.verdict);

	return (
		<div className="flex flex-col gap-2">
			{mine && !changing ? (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span>
						Your answer: <b>{describe(mine)}</b>
					</span>
					<Button size="small" type="link" className="p-0 text-xs" onClick={() => setChanging(true)} disabled={disabled}>
						Change
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<Space.Compact>
						{section.verdicts.map((choice) => (
							<Button
								key={choice}
								type={choice === own || (decided && choice === verdict && !own) ? "primary" : "default"}
								ghost={decided && choice === verdict && !own}
								danger={choice === own}
								disabled={disabled}
								loading={isPending && choice === verdict && !own}
								onClick={() => pick(choice)}
							>
								{label(choice)}
							</Button>
						))}
					</Space.Compact>
					<span className="text-[11px] text-gray-500">{decided ? (own ? "the check is wrong" : "suggested by the check") : "the check could not decide"}</span>
				</div>
			)}

			{own && (!mine || changing) && (
				<div className="flex flex-col gap-2 rounded-md border border-red-100 bg-white p-2">
					<div className="flex flex-wrap gap-1.5">
						{section.reasons.map((r) => (
							<Tag.CheckableTag key={r.code} checked={reason === r.code} onChange={() => setReason(r.code)}>
								{r.label}
							</Tag.CheckableTag>
						))}
					</div>
					<Input
						size="small"
						placeholder="What did the check get wrong?"
						aria-label="Short note"
						value={note}
						maxLength={2000}
						onChange={(e) => setNote(e.target.value)}
					/>
					<div className="flex items-center gap-3">
						<Button size="small" type="primary" disabled={disabled || !reason} loading={isPending} onClick={() => store(own, reason, note)}>
							Save answer: {label(own)}
						</Button>
						<Button size="small" type="link" className="p-0 text-xs" onClick={() => setOwn(null)}>
							Back
						</Button>
					</div>
				</div>
			)}

		</div>
	);
}
