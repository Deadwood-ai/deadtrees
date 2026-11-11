import { useState } from "react";
import { Button, Input, message } from "antd";
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
	myAnswer,
	othersAnswers,
	type EvaluationFlag,
} from "../../../utils/auditChecks";

interface EvaluationAnswerProps {
	datasetId: number;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	/** no audit lease on this page: answers cannot be stored */
	disabled: boolean;
}

const LAYER = "image" as const;
const SECTION = auditSection("evaluation");
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const keeps = (verdict: AuditVerdict | null | undefined) => verdict === "ok" || verdict === "minor";

const call = (on: boolean, tone: "keep" | "exclude") =>
	`flex min-h-[52px] flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
		on
			? tone === "keep"
				? "border-green-700 bg-green-50 text-green-800"
				: "border-red-600 bg-red-50 text-red-700"
			: "border-gray-300 bg-white text-gray-900 hover:border-gray-500"
	}`;
const chip = (on: boolean, tone: "bad" | "warn") =>
	`min-h-[28px] cursor-pointer rounded-full border px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
		on
			? tone === "bad"
				? "border-red-600 bg-red-50 font-medium text-red-700"
				: "border-amber-600 bg-amber-50 font-medium text-amber-800"
			: "border-gray-300 bg-white text-gray-800 hover:border-gray-500"
	}`;

/** Step 1 asks one thing: keep the dataset or exclude it. One click answers it; picking what
 * the check said is agreeing, picking the other is disagreeing. Excluding needs the reason. A
 * kept dataset can carry two flags, a COG issue and a thumbnail issue, preset from the check.
 * Every answer is a new person row on the current run. */
export default function EvaluationAnswer({ datasetId, evidence, people, disabled }: EvaluationAnswerProps) {
	const { user } = useAuth();
	const { mutateAsync: save, isPending } = useSaveAuditAnswers();
	const runId = evidence.run.id;
	const target = { checkKey: "dataset_evaluation" as const, layer: LAYER };
	const verdict = automatedVerdict(evidence, LAYER);
	const rows = automatedRows(evidence, LAYER);
	const rule = rows[0];
	const mine = myAnswer(people, user?.id, runId, target);
	const others = othersAnswers(people, user?.id, runId, target);

	const [changing, setChanging] = useState(false);
	const [excluding, setExcluding] = useState(false);
	const [reason, setReason] = useState<string | null>(verdict === "major" ? text(rule?.details.reason) : null);
	const [note, setNote] = useState("");
	const [draftFlags, setDraftFlags] = useState<EvaluationFlag[]>(() => evaluationFlags(rule));
	const [showOthers, setShowOthers] = useState(false);

	const answered = !!mine && !changing;
	const flags = answered ? evaluationFlags(mine) : draftFlags;

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
	const toggle = (flag: EvaluationFlag) => {
		const next = flags.includes(flag) ? flags.filter((f) => f !== flag) : [...flags, flag];
		// a flag changed after the answer is part of the answer: it is stored at once
		if (answered) void keep(next);
		else setDraftFlags(next);
	};

	const checkSays = !verdict ? "The check made no call." : verdict === "unsure" || !rule ? "The check could not decide." : `The check says ${evaluationAnswerText({ ...rule, verdict })}.`;
	const agrees = (answer: "keep" | "exclude") => (answer === "keep" ? keeps(verdict) : verdict === "major");
	const decided = keeps(verdict) || verdict === "major";
	const hint = (answer: "keep" | "exclude") =>
		decided ? (agrees(answer) ? "as the check says" : "the check is wrong") : answer === "keep" ? "the orthophoto is usable" : "the orthophoto is unusable";
	const myCall = mine ? (keeps(mine.verdict) ? "keep" : "exclude") : null;
	const describe = (a: IAuditAssessment) => `${evaluationAnswerText(a)}${a.reason_text ? `, “${a.reason_text}”` : ""}`;
	const modelSaid = (r: IAuditAssessment) => `${r.assessor_kind === "rule" ? "rule" : r.model}: ${evaluationAnswerText(r)}`;

	return (
		<div className="mb-3 flex flex-col gap-3" data-testid="audit-evaluation-answer">
			<div className="text-xs text-gray-700">
				<b>{checkSays}</b> {text(rule?.details.summary)}
			</div>

			{answered ? (
				<div className="flex flex-col gap-1 rounded-md bg-white px-2.5 py-2 text-xs">
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<span>
							You: <b>{describe(mine)}</b>
							{decided && (agrees(myCall!) ? ", as the check says" : `, the check said ${verdict === "major" ? "exclude" : "keep"}`)}
						</span>
						<Button size="small" type="link" className="p-0 text-xs" onClick={() => setChanging(true)} disabled={disabled}>
							Change
						</Button>
					</div>
				</div>
			) : excluding ? (
				<div className="flex flex-col gap-2 rounded-md border border-red-100 bg-white p-2">
					<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Why exclude</div>
					<div className="flex flex-wrap gap-1.5">
						{SECTION.reasons.map((r) => (
							<button key={r.code} type="button" className={chip(reason === r.code, "bad")} aria-pressed={reason === r.code} onClick={() => setReason(r.code)}>
								{r.label}
							</button>
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
						<button type="button" className={call(false, "keep")} disabled={disabled || isPending} onClick={() => keep(draftFlags)}>
							Keep
							<span className="text-[11px] font-normal text-gray-500">{hint("keep")}</span>
						</button>
						<button type="button" className={call(false, "exclude")} disabled={disabled || isPending} onClick={() => setExcluding(true)}>
							Exclude
							<span className="text-[11px] font-normal text-gray-500">{hint("exclude")}</span>
						</button>
					</div>
				</div>
			)}

			{!excluding && myCall !== "exclude" && (
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Problems to fix, if any</div>
					<div className="flex flex-wrap gap-1.5">
						{EVALUATION_FLAGS.map(({ flag, label }) => (
							<button
								key={flag}
								type="button"
								className={chip(flags.includes(flag), "warn")}
								aria-pressed={flags.includes(flag)}
								disabled={disabled || isPending}
								onClick={() => toggle(flag)}
							>
								{label}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="text-[11px] text-gray-500">
				{answered || showOthers ? (
					<>
						<div>Models: {rows.map(modelSaid).join(" · ") || "none"}</div>
						<div>Other reviewers: {others.length ? others.map((a) => `${a.assessor_email ?? "a reviewer"}: ${describe(a)}`).join(" · ") : "no answers yet"}</div>
					</>
				) : (
					<>
						The models' and other reviewers' answers appear after yours.{" "}
						<button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-blue-700 underline" onClick={() => setShowOthers(true)}>
							Show now
						</button>
					</>
				)}
			</div>
		</div>
	);
}
