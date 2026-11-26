import { useMemo } from "react";
import type { AuditLayer, IAuditAnswerInput, IBenchmarkTarget } from "../../../types/auditChecks";
import type { CropImageKind } from "../../../utils/auditChecks";
import type { CropAnswerRow } from "../../../utils/cropAnswers";
import type { PredictionLayer } from "../../../utils/cropCalls";
import { isLabeled, latestLabelRow } from "../../../utils/benchmarkLabels";
import CropReviewer from "../review/CropReviewer";
import LabeledBy from "./LabeledBy";

const OVERLAY: Record<PredictionLayer, CropImageKind> = { deadwood: "deadwood_overlay", forest_cover: "forest_cover_overlay" };

interface BenchmarkCropReviewProps {
	/** the layer the benchmark scores */
	layer: PredictionLayer;
	/** the crop targets to step through, in order */
	targets: IBenchmarkTarget[];
	current: IBenchmarkTarget | null;
	onSelect: (target: IBenchmarkTarget) => void;
	/** stores a crop's label; false when nothing was saved */
	onSave: (target: IBenchmarkTarget, rows: IAuditAnswerInput[]) => Promise<boolean>;
	/** a random new tile: on to another one without labeling this one */
	onSkip?: () => void;
}

/** A layer's prediction quality benchmark in the audit's crop review, blind: the models' findings
 * (and the problems they would tick) show only on crops that have a label. Each crop has one
 * label, the latest answer whoever gave it; a new answer replaces it. */
export default function BenchmarkCropReview({ layer, targets, current, onSelect, onSave, onSkip }: BenchmarkCropReviewProps) {
	const byCrop = useMemo(() => new Map(targets.map((t) => [t.crop_id!, t])), [targets]);
	const automated = useMemo(() => targets.filter(isLabeled).flatMap((t) => t.models), [targets]);
	const imageOf = (cropId: number, kind: CropImageKind) => byCrop.get(cropId)?.images.find((i) => i.kind === kind) ?? null;
	const label = (cropId: number, layer: AuditLayer) => byCrop.get(cropId)?.people.find((p) => p.layer === layer) ?? null;

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
				label_id: row.layer === "image" ? null : (imageOf(cropId, OVERLAY[layer])?.label_id ?? null),
			})),
		);
	};

	return (
		<CropReviewer
			crops={targets.map((t) => ({ id: t.crop_id!, verdict: null }))}
			layer={layer}
			imageOf={imageOf}
			automated={automated}
			mine={label}
			cropId={current?.crop_id ?? null}
			onSelectCrop={(cropId) => {
				const target = byCrop.get(cropId);
				if (target) onSelect(target);
			}}
			onAnswer={onAnswer}
			header={current && <CropLabel target={current} />}
			blind={!current || !isLabeled(current)}
			onSkip={onSkip}
			active
			disabled={false}
		/>
	);
}

/** Who gave the crop its label, or that it is labeled blind. */
function CropLabel({ target }: { target: IBenchmarkTarget }) {
	const row = latestLabelRow(target);
	return row ? <LabeledBy row={row} /> : <div className="text-xs text-gray-500">Labeled blind: the models show once the crop has a label.</div>;
}
