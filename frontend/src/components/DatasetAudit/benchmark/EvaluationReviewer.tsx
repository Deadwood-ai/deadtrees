import { useState } from "react";
import { Button, Checkbox, Input, Tag } from "antd";
import { useAuditImageAccess } from "../../../hooks/useAuditChecks";
import { auditImageUrl } from "../../../api/auditImages";
import type { DatasetReviewInput, IAuditImage, IDatasetJudgement, IDatasetReview, EvaluationDecision } from "../../../types/auditChecks";
import { EVALUATION_FLAGS, EXCLUDE_REASONS, judgeName, judgementText, type EvaluationFlag } from "../../../utils/auditChecks";
import { evaluationReview, type IEvaluationAnswer } from "../../../utils/auditReview";
import { useAuditShortcuts, type AuditKeyMap } from "../checks/useAuditShortcuts";
import LabeledBy from "./LabeledBy";

const REASONS = EXCLUDE_REASONS;
// q w e r t i o: the old labeler's row, without Y and U (yes and unsure elsewhere in the audit)
const REASON_KEYS = ["q", "w", "e", "r", "t", "i", "o"];
const FLAG_KEYS: Record<EvaluationFlag, string> = { cog_issue: "a", thumbnail_issue: "s" };
const FLAG_FIELD: Record<EvaluationFlag, "cogIssue" | "thumbnailIssue"> = { cog_issue: "cogIssue", thumbnail_issue: "thumbnailIssue" };
const CALLS: { decision: EvaluationDecision; label: string; key: string }[] = [
	{ decision: "keep", label: "OK", key: "1" },
	{ decision: "exclude", label: "Exclude", key: "2" },
];

type Draft = IEvaluationAnswer & { note: string };

const draftOf = (label: IDatasetReview | null): Draft => ({
	decision: label?.decision ?? null,
	excludeReason: label?.exclude_reason ?? null,
	cogIssue: !!label?.cog_issue,
	thumbnailIssue: !!label?.thumbnail_issue,
	note: label?.note ?? "",
});

export interface EvaluationReviewerProps {
	datasetId: number;
	/** the dataset's overview, thumbnail and evaluation tiles (audit.images) */
	images: IAuditImage[];
	/** the dataset's label: the newest review, whoever gave it; a new answer replaces it */
	label: IDatasetReview | null;
	/** each model's answer on the dataset */
	models: IDatasetJudgement[];
	/** benchmark labeling: the models stay hidden until the dataset has a label */
	blind: boolean;
	/** stores the answer and resolves false when nothing was saved */
	onSave: (review: DatasetReviewInput) => Promise<boolean>;
	saving: boolean;
	/** more keys while it is shown, e.g. stepping between datasets */
	keys?: AuditKeyMap;
	/** only while active do its keys answer */
	active?: boolean;
	/** a random new dataset: on to another one without labeling this one */
	onSkip?: () => void;
}

/** The dataset evaluation of one dataset, as the old gold labeler asked it: overview, four
 * tiles and the thumbnail; OK (1) or exclude (2), the exclude reasons (Q W E R T I O) and the
 * issues of a kept dataset (A S); Enter saves, Shift+Space keeps and saves.
 * Mount it with key={datasetId}. */
export default function EvaluationReviewer({ datasetId, images, label, models, blind, onSave, saving, keys = {}, active = true, onSkip }: EvaluationReviewerProps) {
	const [draft, setDraft] = useState<Draft>(draftOf(label));
	const [problem, setProblem] = useState<string | null>(null);
	const revealed = !blind || !!label;

	const save = async (next: Draft) => {
		const answer = evaluationReview(next, datasetId, next.note);
		const missing = !answer ? "Pick OK (1) or exclude (2)" : answer.problems.length ? "Excluding needs a reason" : null;
		if (missing || !answer) {
			setProblem(missing);
			return false;
		}
		setProblem(null);
		return onSave(answer.review);
	};
	const change = (next: Partial<Draft>) => {
		setDraft((d) => ({ ...d, ...next }));
		setProblem(null);
	};
	const decide = (decision: EvaluationDecision) =>
		change(decision === "keep" ? { decision, excludeReason: null } : { decision, cogIssue: false, thumbnailIssue: false });
	const pickReason = (code: string) => change({ decision: "exclude", excludeReason: code, cogIssue: false, thumbnailIssue: false });
	// an issue belongs to a kept dataset
	const toggleFlag = (flag: EvaluationFlag) =>
		setDraft((d) => ({ ...d, [FLAG_FIELD[flag]]: !d[FLAG_FIELD[flag]], decision: "keep", excludeReason: null }));

	useAuditShortcuts(
		saving
			? keys
			: {
					...keys,
					...Object.fromEntries(CALLS.map((c) => [c.key, () => decide(c.decision)])),
					...Object.fromEntries(REASONS.map((r, i) => [REASON_KEYS[i], () => pickReason(r.code)])),
					...Object.fromEntries(EVALUATION_FLAGS.map((f) => [FLAG_KEYS[f.flag], () => toggleFlag(f.flag)])),
					Enter: () => void save(draft),
					"shift+ ": () => void save({ ...draft, decision: "keep", excludeReason: null }),
				},
		active,
	);

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]" data-testid="benchmark-evaluation">
			<DatasetImages images={images} />
			<aside className="flex min-w-0 flex-col gap-3 text-sm">
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Call</div>
					<div className="flex flex-wrap gap-1">
						{CALLS.map((c) => (
							<Button key={c.decision} size="small" type={draft.decision === c.decision ? "primary" : "default"} danger={c.decision === "exclude" && draft.decision === "exclude"} onClick={() => decide(c.decision)}>
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
							<Tag.CheckableTag key={r.code} checked={draft.excludeReason === r.code} onChange={() => pickReason(r.code)}>
								<kbd className="mr-1">{REASON_KEYS[i].toUpperCase()}</kbd>
								{r.label}
							</Tag.CheckableTag>
						))}
					</div>
				</div>
				<div>
					<div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Issues</div>
					<div className="flex flex-wrap gap-2">
						{EVALUATION_FLAGS.map((f) => (
							<Checkbox key={f.flag} checked={!!draft[FLAG_FIELD[f.flag]]} disabled={draft.decision === "exclude"} onChange={() => toggleFlag(f.flag)}>
								<kbd className="mr-1">{FLAG_KEYS[f.flag].toUpperCase()}</kbd>
								{f.label}
							</Checkbox>
						))}
					</div>
				</div>
				<Input.TextArea rows={2} placeholder="Optional note" aria-label="Note" value={draft.note} maxLength={2000} onChange={(e) => change({ note: e.target.value })} />
				{onSkip && (
					<Button block disabled={saving} onClick={onSkip} data-testid="benchmark-skip">
						Skip (K)
					</Button>
				)}
				<Button type="primary" block disabled={saving} loading={saving} onClick={() => void save(draft)}>
					Save → next <kbd className="ml-1">Enter</kbd>
				</Button>
				{problem && <div className="text-xs text-red-600">{problem}</div>}
				{label && <LabeledBy review={label} />}
				{revealed ? (
					<div className="flex flex-col gap-1" data-testid="benchmark-reveal">
						<div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">The models</div>
						{models.length === 0 && <div className="text-xs text-gray-500">No model judged this dataset.</div>}
						{models.map((j) => (
							<div key={j.id} className="flex items-baseline gap-2 text-xs">
								<Tag className="m-0">{judgeName(j.judge)}</Tag>
								<span>
									{judgementText(j)}
									{j.summary?.trim() && ` · ${j.summary.trim()}`}
								</span>
							</div>
						))}
					</div>
				) : (
					<div className="text-[11px] text-gray-500">Labeled blind: the models show once the dataset has a label.</div>
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
