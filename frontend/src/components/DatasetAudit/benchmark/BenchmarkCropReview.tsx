import { useMemo } from "react";
import { Tag } from "antd";
import type { AuditLayer, AuditVerdict, IAuditAnswerInput, IAuditAssessment, IBenchmarkTarget } from "../../../types/auditChecks";
import type { CropImageKind } from "../../../utils/auditChecks";
import type { CropAnswerRow } from "../../../utils/cropAnswers";
import { MODE_LABELS, type PredictionLayer } from "../../../utils/cropCalls";
import { PREDICTION_LAYERS, agreement, answeredBy, cropVerdicts, rowsByPerson, type Agreement } from "../../../utils/benchmarkLabels";
import CropReviewer from "../review/CropReviewer";

const OVERLAY: Record<PredictionLayer, CropImageKind> = { deadwood: "deadwood_overlay", forest_cover: "forest_cover_overlay" };
const LAYER_NAME: Record<PredictionLayer, string> = { deadwood: "Deadwood", forest_cover: "Tree cover" };
const VERDICT_WORD: Record<AuditVerdict, string> = { ok: "OK", minor: "minor", major: "major", unsure: "unsure" };
const TONE: Record<Agreement, string> = { agree: "green", they_flag: "red", you_flag: "orange", other: "default" };

interface BenchmarkCropReviewProps {
	/** the crop targets the filter steps through, in order */
	targets: IBenchmarkTarget[];
	current: IBenchmarkTarget | null;
	userId: string | undefined;
	onSelect: (target: IBenchmarkTarget) => void;
	/** stores a crop's label; false when nothing was saved */
	onSave: (target: IBenchmarkTarget, rows: IAuditAnswerInput[]) => Promise<boolean>;
}

/** The prediction quality benchmark in the audit's crop review, both layers on one crop and
 * blind: the models' findings (and the problems they would tick) reach the reviewer only on
 * crops you have answered, and the other labelers show in the header after your answer. */
export default function BenchmarkCropReview({ targets, current, userId, onSelect, onSave }: BenchmarkCropReviewProps) {
	const byCrop = useMemo(() => new Map(targets.map((t) => [t.crop_id!, t])), [targets]);
	const automated = useMemo(() => targets.filter((t) => answeredBy(t, userId)).flatMap((t) => t.models), [targets, userId]);
	const imageOf = (cropId: number, kind: CropImageKind) => byCrop.get(cropId)?.images.find((i) => i.kind === kind) ?? null;
	const mine = (cropId: number, layer: AuditLayer) =>
		byCrop.get(cropId)?.people.find((p) => p.assessor_user_id === userId && p.layer === layer) ?? null;

	const onAnswer = (cropId: number, rows: CropAnswerRow[]) => {
		const target = byCrop.get(cropId);
		if (!target) return Promise.resolve(false);
		return onSave(
			target,
			rows.map((row) => ({
				...row,
				check_key: "prediction_quality",
				dataset_id: target.dataset_id,
				run_id: target.run_id,
				crop_id: cropId,
				label_id: row.layer === "image" ? null : (imageOf(cropId, OVERLAY[row.layer as PredictionLayer])?.label_id ?? null),
			})),
		);
	};

	return (
		<CropReviewer
			crops={targets.map((t) => ({ id: t.crop_id!, flagged: false }))}
			layers={PREDICTION_LAYERS}
			imageOf={imageOf}
			automated={automated}
			mine={mine}
			cropId={current?.crop_id ?? null}
			onSelectCrop={(cropId) => {
				const target = byCrop.get(cropId);
				if (target) onSelect(target);
			}}
			onAnswer={onAnswer}
			header={current && <OtherLabelers target={current} userId={userId} />}
			active
			disabled={false}
		/>
	);
}

/** After your answer: each other labeler's call per layer, coloured by how it compares with
 * yours, with the problems they saw. Before it, a line that the crop is labeled blind. */
function OtherLabelers({ target, userId }: { target: IBenchmarkTarget; userId: string | undefined }) {
	if (!answeredBy(target, userId)) {
		return <div className="text-xs text-gray-500">Labeled blind: other labelers and the models show after your answer.</div>;
	}
	const people = rowsByPerson(target.people);
	const mine = cropVerdicts(people.get(userId!) ?? []);
	const others = [...people.entries()].filter(([id]) => id !== userId);
	if (!others.length) return <div className="text-xs text-gray-500">Nobody else labeled this crop yet.</div>;
	return (
		<div className="flex flex-col gap-1 text-xs" data-testid="benchmark-others">
			{others.map(([id, rows]) => {
				const theirs = cropVerdicts(rows);
				const name = (rows[0].assessor_email ?? "labeler").split("@")[0];
				if (theirs === "cant_tell") {
					return (
						<div key={id}>
							<b>{name}</b>: <Tag color={mine === "cant_tell" ? "green" : "orange"}>can't tell what it shows</Tag>
						</div>
					);
				}
				return (
					<div key={id} className="flex flex-wrap items-center gap-1">
						<b>{name}</b>:
						{PREDICTION_LAYERS.map((layer) => {
							const row: IAuditAssessment | undefined = rows.find((r) => r.layer === layer);
							if (!row) return null;
							const tone = agreement(mine === "cant_tell" ? null : mine[layer], row.verdict);
							const seen = Object.keys(row.modes ?? {}).map((m) => MODE_LABELS[m] ?? m);
							return (
								<Tag key={layer} color={tone ? TONE[tone] : "default"} className="m-0">
									{LAYER_NAME[layer]} {VERDICT_WORD[row.verdict]}
									{seen.length ? ` · ${seen.join(", ")}` : ""}
								</Tag>
							);
						})}
					</div>
				);
			})}
			<div className="text-[11px] text-gray-500">Green as you said · red they found a problem you did not · orange the other way round</div>
		</div>
	);
}
