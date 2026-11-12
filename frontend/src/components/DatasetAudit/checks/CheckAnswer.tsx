import { useState } from "react";
import { Button, Input, Tag, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import ShowNow from "./ShowNow";
import {
	automatedRows,
	automatedVerdict,
	myAnswer,
	othersAnswers,
	verdictLabel,
	wrongVerdict,
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

/** Agree with a check, or mark it wrong with a fixed reason and a note. Every answer is a
 * new person row on the current run; other reviewers' answers stay hidden until you answer. */
export default function CheckAnswer({ datasetId, section, layer, evidence, people, disabled }: CheckAnswerProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const [changing, setChanging] = useState(false);
	const [wrongOpen, setWrongOpen] = useState(false);
	const [reason, setReason] = useState<string | null>(null);
	const [own, setOwn] = useState<AuditVerdict | null>(null);
	const [note, setNote] = useState("");
	const [showOthers, setShowOthers] = useState(false);

	const checkKey = section.checkKey!;
	const runId = evidence.run.id;
	const target = { checkKey, layer };
	const verdict = automatedVerdict(evidence, layer);
	const rows = automatedRows(evidence, layer);
	const mine = myAnswer(people, user?.id, runId, target);
	const others = othersAnswers(people, user?.id, runId, target);
	const decided = verdict !== null && verdict !== "unsure";
	const flipped = decided ? wrongVerdict(verdict) : null;
	const choices = section.verdicts;
	const twoWay = choices.length === 2;
	const wrongTo = twoWay ? flipped : own;
	const label = (v: AuditVerdict) => verdictLabel(checkKey, v);

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
			setWrongOpen(false);
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
	const reveal = !!mine || showOthers;

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
			) : decided ? (
				<div className="flex flex-wrap gap-2">
					<Button type="primary" ghost disabled={disabled} loading={isPending && !wrongOpen} onClick={() => store(verdict)}>
						Agree
					</Button>
					<Button danger={wrongOpen} disabled={disabled} onClick={() => setWrongOpen((o) => !o)} aria-expanded={wrongOpen}>
						Check wrong
					</Button>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="text-gray-600">The check could not decide. Your call:</span>
					{choices.map((c) => (
						<Button key={c} size="small" disabled={disabled} onClick={() => store(c)}>
							{label(c)}
						</Button>
					))}
				</div>
			)}

			{wrongOpen && (!mine || changing) && (
				<div className="flex flex-col gap-2 rounded-md border border-red-100 bg-white p-2">
					<div className="flex flex-wrap gap-1.5">
						{section.reasons.map((r) => (
							<Tag.CheckableTag key={r.code} checked={reason === r.code} onChange={() => setReason(r.code)}>
								{r.label}
							</Tag.CheckableTag>
						))}
					</div>
					{!twoWay && (
						<div className="flex flex-wrap items-center gap-1.5 text-xs">
							<span className="text-gray-600">Your verdict:</span>
							{choices
								.filter((c) => c !== verdict)
								.map((c) => (
									<Tag.CheckableTag key={c} checked={own === c} onChange={() => setOwn(c)}>
										{label(c)}
									</Tag.CheckableTag>
								))}
						</div>
					)}
					<Input
						size="small"
						placeholder="What did the check get wrong?"
						aria-label="Short note"
						value={note}
						maxLength={2000}
						onChange={(e) => setNote(e.target.value)}
					/>
					<div>
						<Button
							size="small"
							type="primary"
							disabled={disabled || !reason || !wrongTo}
							loading={isPending}
							onClick={() => wrongTo && store(wrongTo, reason, note)}
						>
							Save answer{wrongTo ? `: ${label(wrongTo)}` : ""}
						</Button>
					</div>
				</div>
			)}

			<div className="text-[11px] text-gray-500">
				{reveal ? (
					<>
						<div>
							Models: {rows.map((r) => `${r.model}/${r.prompt_version} ${label(r.verdict)}`).join(" · ") || "none"}
						</div>
						<div>
							Other reviewers:{" "}
							{others.length ? others.map((a) => `${a.assessor_email ?? "a reviewer"}: ${describe(a)}`).join(" · ") : "no answers yet"}
						</div>
					</>
				) : (
					<>
						Other reviewers' and the models' answers appear after you answer.{" "}
						<ShowNow onClick={() => setShowOthers(true)} />
					</>
				)}
			</div>
		</div>
	);
}
