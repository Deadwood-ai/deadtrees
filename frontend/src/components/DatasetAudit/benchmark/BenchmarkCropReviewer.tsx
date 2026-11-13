import { useState } from "react";
import { Button, Input } from "antd";
import type { AuditImageKind, AuditVerdict, IAuditAnswerInput, IAuditAssessment, IBenchmarkTarget } from "../../../types/auditChecks";
import { verdictLabel } from "../../../utils/auditChecks";
import {
	PREDICTION_LAYERS,
	QUESTIONS,
	agreement,
	answerQuestion,
	cropAnswerRows,
	draftFromRows,
	emptyDraft,
	layerFine,
	problemAnswer,
	questionLabel,
	rowsByPerson,
	setVerdict,
	wholeCropFine,
	type Agreement,
	type ICropDraft,
	type ModeAnswer,
	type PredictionLayer,
} from "../../../utils/benchmarkLabels";
import { useAuditShortcuts } from "../checks/useAuditShortcuts";
import CropImagePane, { type IPaneImage } from "./CropImagePane";

const PANELS: IPaneImage[] = [
	{ kind: "raw", caption: "Raw" },
	{ kind: "deadwood_overlay", caption: "Deadwood (blue)" },
	{ kind: "forest_cover_overlay", caption: "Tree cover (gold)" },
];
const OVERLAY: Record<PredictionLayer, AuditImageKind> = { deadwood: "deadwood_overlay", forest_cover: "forest_cover_overlay" };
const LAYER_TITLE: Record<PredictionLayer, string> = { deadwood: "Deadwood (blue)", forest_cover: "Tree cover (gold)" };
const VERDICTS: AuditVerdict[] = ["ok", "minor", "major"];
const ANSWER_LABEL: Record<ModeAnswer, string> = { yes: "Yes", no: "No", unsure: "?" };
const AGREEMENT_CLASS: Record<Agreement, string> = {
	agree: "border-green-500",
	they_flag: "border-red-500",
	you_flag: "border-amber-500",
	other: "border-gray-300",
};

interface BenchmarkCropReviewerProps {
	target: IBenchmarkTarget;
	userId: string | undefined;
	/** stores the rows and moves on; resolves false when nothing was saved */
	onSave: (rows: IAuditAnswerInput[]) => Promise<boolean>;
	onStep: (by: 1 | -1) => void;
	onNextOpen: () => void;
	saving: boolean;
}

/** One prediction quality benchmark crop, both layers at once, answered blind: the other
 * labelers' and the models' answers show only after yours. Keys follow the audit keymap:
 * Y / N / U answer the problem under the cursor, ↑ ↓ move, 1 2 3 give the layer OK, minor or
 * major, Space marks the layer fine, Shift+Space the whole crop (saved, next), Enter saves with
 * the rest = No and goes on, C "can't tell what this shows", T raw ⇄ prediction, V side by side,
 * ← → step, Tab next crop without your answer. Mount it with key={target.id}. */
export default function BenchmarkCropReviewer({ target, userId, onSave, onStep, onNextOpen, saving }: BenchmarkCropReviewerProps) {
	const mineRows = target.people.filter((p) => p.assessor_user_id === userId);
	const stored = draftFromRows(mineRows);
	const [draft, setDraft] = useState<ICropDraft>(stored ?? emptyDraft());
	const [cursor, setCursor] = useState(0);
	const storedNote = mineRows.find((r) => r.layer === "image")?.details.note;
	const [note, setNote] = useState(typeof storedNote === "string" ? storedNote : "");
	const [sideBySide, setSideBySide] = useState(true);
	const [showRaw, setShowRaw] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const question = QUESTIONS[cursor];
	const answered = !!stored;
	const firstOf = (layer: PredictionLayer) => QUESTIONS.findIndex((q) => q.layer === layer);
	const nextLayerStart = () => {
		const next = PREDICTION_LAYERS[PREDICTION_LAYERS.indexOf(question.layer) + 1];
		return next ? firstOf(next) : cursor;
	};
	const labelIds = Object.fromEntries(
		PREDICTION_LAYERS.map((layer) => [layer, target.images.find((i) => i.kind === OVERLAY[layer])?.label_id ?? null]),
	);

	const save = async (next: ICropDraft) => {
		const result = cropAnswerRows(next, { datasetId: target.dataset_id, cropId: target.crop_id!, labelIds }, note);
		if ("missing" in result) {
			setProblem(result.missing);
			return;
		}
		setProblem(null);
		await onSave(result.rows);
	};
	const update = (next: ICropDraft, moveTo = cursor) => {
		setDraft(next);
		setCursor(Math.max(0, Math.min(QUESTIONS.length - 1, moveTo)));
		setProblem(null);
	};
	const answer = (value: ModeAnswer) => update(answerQuestion(draft, question, value), question.mode ? cursor + 1 : cursor);
	const verdict = (v: AuditVerdict) => update(setVerdict(draft, question.layer, v), nextLayerStart());
	const both = (key: string, action: () => void) => ({ [key]: action, [key.toUpperCase()]: action });

	useAuditShortcuts(
		saving
			? {}
			: {
					...both("y", () => answer("yes")),
					...both("n", () => answer("no")),
					...both("u", () => answer("unsure")),
					"1": () => verdict("ok"),
					"2": () => verdict("minor"),
					"3": () => verdict("major"),
					ArrowDown: () => setCursor(Math.min(QUESTIONS.length - 1, cursor + 1)),
					ArrowUp: () => setCursor(Math.max(0, cursor - 1)),
					" ": () => update(layerFine(draft, question.layer), nextLayerStart()),
					"shift+ ": () => void save(wholeCropFine(draft)),
					Enter: () => void save(draft),
					...both("c", () => void save({ ...draft, cantTell: true })),
					...both("t", () => {
						setSideBySide(false);
						setShowRaw((raw) => !raw);
					}),
					...both("v", () => setSideBySide((s) => !s)),
					ArrowRight: () => onStep(1),
					ArrowLeft: () => onStep(-1),
					Tab: onNextOpen,
				},
		true,
	);

	const others = [...rowsByPerson(target.people, userId).entries()].filter(([id]) => id !== userId);
	const models = [...new Set(target.models.map((m) => m.assessor))];
	const columns: { key: string; title: string; rows: IAuditAssessment[] }[] = answered
		? [
				...others.map(([id, rows]) => ({ key: id, title: (rows[0].assessor_email ?? "labeler").split("@")[0], rows })),
				...models.map((m) => ({ key: m, title: m.replace("/", " "), rows: target.models.filter((r) => r.assessor === m) })),
			]
		: [];
	const cell = (rows: IAuditAssessment[], layer: PredictionLayer, mode: string | null, mine: ModeAnswer | AuditVerdict | null) => {
		const cantTell = rows.some((r) => r.layer === "image" && r.verdict === "major");
		const row = rows.find((r) => r.layer === layer);
		const theirs = cantTell ? null : mode ? problemAnswer(row, mode) : (row?.verdict ?? null);
		const likelihood = mode && row?.assessor_kind !== "person" ? (row?.modes?.[mode] as { likelihood?: number } | undefined)?.likelihood : row?.major_likelihood;
		const tone = agreement(mine, theirs);
		return (
			<span className={`inline-block min-w-[3.5rem] rounded border px-1 text-center text-[11px] ${tone ? AGREEMENT_CLASS[tone] : "border-transparent text-gray-400"}`}>
				{cantTell ? "can't tell" : theirs ? (mode ? ANSWER_LABEL[theirs as ModeAnswer] : verdictLabel("prediction_quality", theirs as AuditVerdict)) : "–"}
				{typeof likelihood === "number" && <small className="ml-1 text-gray-500">{Math.round(likelihood)}</small>}
			</span>
		);
	};

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_420px]" data-testid="benchmark-crop">
			<div className="flex min-w-0 flex-col gap-2">
				<CropImagePane images={target.images} panels={PANELS} sideBySide={sideBySide} single={showRaw ? "raw" : OVERLAY[question.layer]} active={draft.cantTell ? null : OVERLAY[question.layer]} />
				<div className="text-[11px] text-gray-500">
					<kbd>T</kbd> one image, raw ⇄ prediction · <kbd>V</kbd> side by side · wheel zooms every panel, double click resets
				</div>
			</div>
			<aside className="flex min-w-0 flex-col gap-2 text-sm">
				<div className="flex gap-2">
					<Button type="primary" className="flex-1" disabled={saving} onClick={() => void save(wholeCropFine(draft))}>
						Whole crop fine → next <kbd className="ml-1">Shift</kbd>+<kbd>Space</kbd>
					</Button>
					<Button disabled={saving} onClick={() => void save({ ...draft, cantTell: true })} danger={draft.cantTell}>
						Can't tell <kbd className="ml-1">C</kbd>
					</Button>
				</div>
				{columns.length > 0 && (
					<div className="flex justify-end gap-1 pr-1 text-[11px] font-semibold text-gray-600" data-testid="benchmark-reveal">
						{columns.map((c) => (
							<span key={c.key} className="min-w-[3.5rem] truncate text-center" title={c.title}>
								{c.title}
							</span>
						))}
					</div>
				)}
				{PREDICTION_LAYERS.map((layer) => (
					<div key={layer} className={`rounded border p-2 ${question.layer === layer && !draft.cantTell ? "border-sky-400" : "border-gray-200"}`}>
						<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{LAYER_TITLE[layer]}</div>
						{QUESTIONS.map((q, index) =>
							q.layer !== layer ? null : (
								<div
									key={`${q.layer}:${q.mode}`}
									className={`flex items-center gap-2 rounded px-1 py-0.5 ${index === cursor ? "bg-sky-50 outline outline-1 outline-sky-300" : ""}`}
									onClick={() => setCursor(index)}
									data-testid={`benchmark-question-${q.mode ?? `${layer}-verdict`}`}
								>
									<span className="flex-1 text-xs">{q.mode ? questionLabel(q.mode) : "Verdict"}</span>
									{q.mode ? (
										<span className="flex gap-0.5">
											{(["yes", "no", "unsure"] as ModeAnswer[]).map((a) => (
												<Button
													key={a}
													size="small"
													type={draft.layers[layer].modes[q.mode!] === a ? "primary" : "default"}
													danger={a === "yes" && draft.layers[layer].modes[q.mode!] === a}
													onClick={() => update(answerQuestion(draft, q, a), index + 1)}
												>
													{a === "yes" ? "Y" : a === "no" ? "N" : "U"}
												</Button>
											))}
										</span>
									) : (
										<span className="flex gap-0.5">
											{VERDICTS.map((v, i) => (
												<Button key={v} size="small" type={draft.layers[layer].verdict === v ? "primary" : "default"} danger={v === "major" && draft.layers[layer].verdict === v} onClick={() => update(setVerdict(draft, layer, v), index)}>
													{i + 1} {verdictLabel("prediction_quality", v)}
												</Button>
											))}
										</span>
									)}
									{columns.map((c) => (
										<span key={c.key}>{cell(c.rows, layer, q.mode, q.mode ? (stored?.layers[layer].modes[q.mode] ?? null) : (stored?.layers[layer].verdict ?? null))}</span>
									))}
								</div>
							),
						)}
					</div>
				))}
				<Input.TextArea rows={2} placeholder="Optional note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
				<Button block disabled={saving} loading={saving} onClick={() => void save(draft)}>
					Save, rest = No → next <kbd className="ml-1">Enter</kbd>
				</Button>
				{problem && <div className="text-xs text-red-600">{problem}</div>}
				{answered ? (
					<div className="text-[11px] text-gray-600">
						{columns.length
							? "Borders: green agrees with you · red they flag, you did not · amber you flag, they did not. Small number: the model's score."
							: "Nobody else labeled this crop yet, and no model judged it."}
					</div>
				) : (
					<div className="text-[11px] text-gray-500">Other labelers and the models show once you have answered.</div>
				)}
				<div className="text-[11px] text-gray-500">
					<kbd>Y</kbd> <kbd>N</kbd> <kbd>U</kbd> yes / no / unsure · <kbd>↑</kbd> <kbd>↓</kbd> problem · <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> OK / minor / major · <kbd>Space</kbd> layer fine · <kbd>←</kbd> <kbd>→</kbd> crops · <kbd>Tab</kbd> next open
				</div>
			</aside>
		</div>
	);
}

