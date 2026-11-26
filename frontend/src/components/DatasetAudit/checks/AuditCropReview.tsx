import { useEffect, useMemo } from "react";
import { message } from "antd";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { orderedCrops, reviewAnswer, type IAuditSectionDef } from "../../../utils/auditChecks";
import { layerReview, type CropAnswerRow } from "../../../utils/cropAnswers";
import { cropCalls, decider, type PredictionLayer } from "../../../utils/cropCalls";
import CropReviewer from "../review/CropReviewer";
import { useBenchmarkToggle } from "../benchmark/useBenchmarkToggle";
import { modelViewImage } from "./auditCheckView";

export interface AuditCropReviewProps {
	datasetId: number;
	/** the open prediction step: one layer */
	section: IAuditSectionDef;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	onShowMap: () => void;
	/** on to the audit's next step */
	onNextStep: () => void;
	disabled: boolean;
}

/** A prediction step's crops in the crop review, over the map; each answer is stored at once as
 * person rows on the check's run. The layer itself never needs review. B adds the crop to the
 * layer's benchmark, labeled with your answer, or takes it out again (operators). */
export default function AuditCropReview({ datasetId, section, evidence, people, cropId, onSelectCrop, onShowMap, onNextStep, disabled }: AuditCropReviewProps) {
	const { mutateAsync: save } = useSaveAuditAnswers();
	const layer = section.layers[0] as PredictionLayer;
	const calls = useMemo(() => cropCalls(evidence, [layer]), [evidence, layer]);
	const crops = useMemo(() => orderedCrops(evidence), [evidence]);
	const review = layerReview(evidence, calls, layer, people);
	const checkKey = section.checkKey!;
	const runId = evidence.run.id;
	const benchmark = useBenchmarkToggle({ check_key: checkKey, layer }, datasetId);

	const first = crops[0];
	useEffect(() => {
		if (cropId === null && first) onSelectCrop(first.id);
		// only when the review opens: a crop picked later stays
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const onAnswer = async (id: number, rows: CropAnswerRow[]) => {
		try {
			await save(
				rows.map((row) => ({ ...row, check_key: checkKey, dataset_id: datasetId, run_id: runId, crop_id: id, label_id: row.layer === "image" ? null : review.labelId })),
			);
			return true;
		} catch {
			message.error("Your crop answer was not saved. Please try again.");
			return false;
		}
	};

	return (
		<CropReviewer
			crops={crops.map((c) => {
				const call = calls.get(c.id);
				return { id: c.id, verdict: call?.verdict ?? null };
			})}
			layer={layer}
			imageOf={(id, kind) => modelViewImage(evidence, id, kind)}
			automated={evidence.automated}
			decider={decider(evidence)}
			mine={(id, l: AuditLayer) => reviewAnswer(people, runId, { checkKey, layer: l, cropId: id })}
			checkMajor={(id) => {
				const verdict = calls.get(id)?.verdict;
				return verdict ? verdict === "major" : null;
			}}
			cropId={cropId}
			onSelectCrop={onSelectCrop}
			onAnswer={onAnswer}
			onDone={onNextStep}
			onShowMap={onShowMap}
			benchmark={benchmark}
			active
			disabled={disabled}
			header={
				<div className="text-base font-semibold" data-testid="crop-review-header">
					{section.title}
				</div>
			}
		/>
	);
}
