import { useState } from "react";
import { Button, Checkbox, Input, Tag } from "antd";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import { auditImageUrl } from "../../../api/auditImages";
import type { AuditVerdict, IAuditAnswerInput, IAuditAssessment, IAuditImage } from "../../../types/auditChecks";
import { EVALUATION_FLAGS, auditSection, evaluationAnswerText, keepsDataset, type EvaluationFlag } from "../../../utils/auditChecks";
import { emptyEvaluationDraft, evaluationAnswerRow, evaluationDraftFromRow, type IEvaluationDraft } from "../../../utils/benchmarkLabels";
import { useAuditShortcuts, type AuditKeyMap } from "../checks/useAuditShortcuts";

const REASONS = auditSection("evaluation").reasons;
// q w e r t i o: the old labeler's row, without Y and U (yes and unsure elsewhere in the audit)
const REASON_KEYS = ["q", "w", "e", "r", "t", "i", "o"];
const FLAG_KEYS: Record<EvaluationFlag, string> = { cog_issue: "a", thumbnail_issue: "s", reprocess: "d" };
const CALLS: { verdict: AuditVerdict; label: string; key: string }[] = [
	{ verdict: "ok", label: "Keep", key: "1" },
	{ verdict: "minor", label: "Keep, fix", key: "2" },
	{ verdict: "major", label: "Exclude", key: "3" },
	{ verdict: "unsure", label: "Unsure", key: "U" },
];

export interface EvaluationReviewerProps {
	datasetId: number;
	/** the dataset's overview, thumbnail and evaluation crops (audit.images) */
	images: IAuditImage[];
	/** your latest answer on the dataset, if any */
	mine: IAuditAssessment | null;
	/** other people's latest answers */
	others: IAuditAssessment[];
	/** the check's model and rule rows on the dataset */
	models: IAuditAssessment[];
	/** benchmark labeling: others and the models stay hidden until you have answered */
	blind: boolean;
	/** stores the answer (run_id null; a caller on a check run sets its own) and resolves false when nothing was saved */
	onSave: (row: IAuditAnswerInput) => Promise<boolean>;
	saving: boolean;
	/** more keys while it is shown, e.g. stepping between datasets */
	keys?: AuditKeyMap;
	/** only while active do its keys answer */
	active?: boolean;
}

/** The dataset evaluation of one dataset, as the old gold labeler asked it: overview, four
 * crops and the thumbnail; keep (1), keep but fix (2), exclude (3) or unsure (U), the exclude
 * reasons (Q W E R T I O) and the fix flags (A S D); Enter saves, Shift+Space keeps and saves.
 * Mount it with key={datasetId}. */
export default function EvaluationReviewer({ datasetId, images, mine, others, models, blind, onSave, saving, keys = {}, active = true }: EvaluationReviewerProps) {
	const [draft, setDraft] = useState<IEvaluationDraft>(evaluationDraftFromRow(mine ?? undefined) ?? emptyEvaluationDraft());
	const [problem, setProblem] = useState<string | null>(null);
	const revealed = !blind || !!mine;

	const save = async (next: IEvaluationDraft) => {
		const result = evaluationAnswerRow(next, datasetId);
		if ("missing" in result) {
			setProblem(result.missing);
			return false;
		}
		setProblem(null);
		return onSave(result.rows[0]);
	};
	const change = (next: Partial<IEvaluationDraft>) => {
		setDraft((d) => ({ ...d, ...next }));
		setProblem(null);
	};
	const pickReason = (code: string) => change({ verdict: "major", reason: code, flags: [] });
	const toggleFlag = (flag: EvaluationFlag) =>
		setDraft((d) => {
			const flags = d.flags.includes(flag) ? d.flags.filter((f) => f !== flag) : [...d.flags, flag];
			return { ...d, flags, verdict: keepsDataset(d.verdict) || d.verdict === null ? (flags.length ? "minor" : "ok") : d.verdict, reason: null };
		});

	useAuditShortcuts(
		saving
			? keys
			: {
					...keys,
					...Object.fromEntries(CALLS.flatMap((c) => [c.key, c.key.toLowerCase()].map((k) => [k, () => change({ verdict: c.verdict, reason: c.verdict === "major" ? draft.reason : null })]))),
					...Object.fromEntries(REASONS.map((r, i) => [REASON_KEYS[i], () => pickReason(r.code)])),
					...Object.fromEntries(EVALUATION_FLAGS.map((f) => [FLAG_KEYS[f.flag], () => toggleFlag(f.flag)])),
					Enter: () => void save(draft),
					"shift+ ": () => void save({ ...draft, verdict: draft.flags.length ? "minor" : "ok", reason: null }),
				},
		active,
	);

	const describe = (row: IAuditAssessment) => {
		if (row.assessor_kind === "person") return evaluationAnswerText(row);
		const named = Object.entries(row.modes ?? {})
			.filter(([, m]) => (m.likelihood ?? 0) >= 50)
			.map(([key]) => key.replace(/_/g, " "));
		return `${evaluationAnswerText(row)}${named.length ? ` · ${named.join(", ")}` : ""}`;
	};
	const tone = (row: IAuditAssessment) => (!mine ? "default" : keepsDataset(row.verdict) === keepsDataset(mine.verdict) ? "green" : "red");

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]" data-testid="benchmark-evaluation">
			<DatasetImages images={images} />
			<aside className="flex min-w-0 flex-col gap-3 text-sm">
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Call</div>
					<div className="flex flex-wrap gap-1">
						{CALLS.map((c) => (
							<Button key={c.verdict} size="small" type={draft.verdict === c.verdict ? "primary" : "default"} danger={c.verdict === "major" && draft.verdict === "major"} onClick={() => change({ verdict: c.verdict, reason: c.verdict === "major" ? draft.reason : null })}>
								<kbd className="mr-1">{c.key}</kbd>
								{c.label}
							</Button>
						))}
					</div>
				</div>
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Exclude because</div>
					<div className="flex flex-wrap gap-1">
						{REASONS.map((r, i) => (
							<Tag.CheckableTag key={r.code} checked={draft.reason === r.code} onChange={() => pickReason(r.code)}>
								<kbd className="mr-1">{REASON_KEYS[i].toUpperCase()}</kbd>
								{r.label}
							</Tag.CheckableTag>
						))}
					</div>
				</div>
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Fix</div>
					<div className="flex flex-wrap gap-2">
						{EVALUATION_FLAGS.map((f) => (
							<Checkbox key={f.flag} checked={draft.flags.includes(f.flag)} disabled={draft.verdict === "major"} onChange={() => toggleFlag(f.flag)}>
								<kbd className="mr-1">{FLAG_KEYS[f.flag].toUpperCase()}</kbd>
								{f.label}
							</Checkbox>
						))}
					</div>
				</div>
				<Input.TextArea rows={2} placeholder="Optional note" aria-label="Note" value={draft.note} maxLength={2000} onChange={(e) => change({ note: e.target.value })} />
				<Button type="primary" block disabled={saving} loading={saving} onClick={() => void save(draft)}>
					Save → next <kbd className="ml-1">Enter</kbd>
				</Button>
				{problem && <div className="text-xs text-red-600">{problem}</div>}
				{revealed ? (
					<div className="flex flex-col gap-1" data-testid="benchmark-reveal">
						<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Others and the models</div>
						{others.length + models.length === 0 && <div className="text-xs text-gray-500">Nobody else labeled this dataset yet, and no model judged it.</div>}
						{[...others, ...models].map((row) => (
							<div key={row.id} className="flex items-baseline gap-2 text-xs">
								<Tag color={tone(row)} className="m-0">
									{row.assessor_kind === "person" ? (row.assessor_email ?? "labeler").split("@")[0] : row.assessor.replace("/", " ")}
								</Tag>
								<span>{describe(row)}</span>
							</div>
						))}
					</div>
				) : (
					<div className="text-[11px] text-gray-500">Other labelers and the models show once you have answered.</div>
				)}
				<div className="text-[11px] text-gray-500">
					<kbd>Shift</kbd>+<kbd>Space</kbd> keep and save · <kbd>←</kbd> <kbd>→</kbd> datasets · <kbd>Tab</kbd> next open
				</div>
			</aside>
		</div>
	);
}

/** The overview large, the evaluation crops beside it and the website thumbnail below. */
function DatasetImages({ images }: { images: IAuditImage[] }) {
	const { data: grant } = useAuditImageAccess();
	const overview = images.find((i) => i.kind === "overview");
	const thumbnail = images.find((i) => i.kind === "thumbnail");
	const crops = images.filter((i) => i.kind === "raw").slice(0, 4);
	if (!images.length) return <div className="flex items-center justify-center rounded bg-gray-100 p-8 text-sm text-gray-500">The dataset evaluation has not stored images of this dataset yet.</div>;
	const img = (image: IAuditImage, caption: string, className: string) => (
		<figure key={image.id} className={`relative m-0 overflow-hidden rounded bg-black ${className}`}>
			{grant && <img src={auditImageUrl(grant, image.storage_path)} alt={caption} className="h-full w-full object-contain" />}
			<figcaption className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 text-[11px] text-white">{caption}</figcaption>
		</figure>
	);
	return (
		<div className="grid min-w-0 grid-cols-[3fr_2fr] gap-2" data-testid="benchmark-evaluation-images">
			<div className="flex flex-col gap-2">
				{overview && img(overview, "Overview", "aspect-square")}
				{thumbnail && img(thumbnail, "Thumbnail (website)", "aspect-square w-1/2")}
			</div>
			<div className="grid grid-cols-2 content-start gap-2">{crops.map((c, i) => img(c, `Crop ${i + 1}`, "aspect-square"))}</div>
		</div>
	);
}
