import { useState } from "react";
import { Button, Form, Input, message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswer } from "../../../hooks/useAuditChecks";
import type { AuditLayer, AuditVerdict, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import {
	automatedRows,
	automatedVerdict,
	formValuesForVerdict,
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

const chip = (on: boolean) =>
	`min-h-[32px] cursor-pointer rounded-md border px-2.5 text-xs ${on ? "border-blue-700 bg-blue-700 text-white" : "border-gray-300 bg-white text-gray-800 hover:border-gray-500"}`;

/** Agree with a check, or mark it wrong with a fixed reason and a note. Every answer is a
 * new person row on the current run; other reviewers' answers stay hidden until you answer. */
export default function CheckAnswer({ datasetId, section, layer, evidence, people, disabled }: CheckAnswerProps) {
	const form = Form.useFormInstance();
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswer();
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
			await save({
				check_key: checkKey,
				dataset_id: datasetId,
				run_id: runId,
				layer,
				label_id: rows[0]?.label_id ?? null,
				verdict: answer,
				reason_code: reasonCode,
				reason_text: reasonText?.trim() || null,
			});
			form.setFieldsValue(formValuesForVerdict(checkKey, layer, answer, rows));
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
					<Button disabled={disabled} loading={isPending && !wrongOpen} onClick={() => store(verdict)}>
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
							<button key={r.code} type="button" className={chip(reason === r.code)} onClick={() => setReason(r.code)}>
								{r.label}
							</button>
						))}
					</div>
					{!twoWay && (
						<div className="flex flex-wrap items-center gap-1.5 text-xs">
							<span className="text-gray-600">Your verdict:</span>
							{choices
								.filter((c) => c !== verdict)
								.map((c) => (
									<button key={c} type="button" className={chip(own === c)} onClick={() => setOwn(c)}>
										{label(c)}
									</button>
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
						<button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-blue-700 underline" onClick={() => setShowOthers(true)}>
							Show now
						</button>
					</>
				)}
			</div>
		</div>
	);
}
