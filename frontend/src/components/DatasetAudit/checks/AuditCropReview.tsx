import { message } from "antd";
import { useAuth } from "../../../hooks/useAuthProvider";
import { useSaveAuditAnswers } from "../../../hooks/useAuditChecks";
import type { AuditLayer, IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import { QUALITY_VERDICT, automatedRows, myAnswer, type IAuditSectionDef } from "../../../utils/auditChecks";
import type { CropAnswerRow } from "../../../utils/cropAnswers";
import { cropMajor, type PredictionLayer } from "../../../utils/cropCalls";
import CropReviewer from "../review/CropReviewer";
import { modelViewImage } from "./auditCheckView";
import LayerRatingLine from "./LayerRatingLine";
import { useLayerRating } from "./useLayerRating";

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

/** A prediction step's crops in the crop review, over the map: your answers become person rows
 * on the check's run, and Enter after the last crop stores the layer rating that follows from
 * them, which moves the audit on to the next step. */
export default function AuditCropReview({ datasetId, section, evidence, people, cropId, onSelectCrop, onShowMap, onNextStep, disabled }: AuditCropReviewProps) {
	const { user } = useAuth();
	const { mutateAsync: save } = useSaveAuditAnswers();
	const { calls, crops, rating, answered, layer } = useLayerRating(section, evidence, people);
	const checkKey = section.checkKey!;
	const runId = evidence.run.id;
	// the prediction the layer's rule row judged, as the step's Enter stores it
	const labelOf = (l: AuditLayer) => automatedRows(evidence, l)[0]?.label_id ?? null;

	const onAnswer = async (id: number, rows: CropAnswerRow[]) => {
		try {
			await save(rows.map((row) => ({ ...row, check_key: checkKey, dataset_id: datasetId, run_id: runId, crop_id: id, label_id: row.layer === "image" ? null : labelOf(row.layer) })));
			return true;
		} catch {
			message.error("Your crop answer was not saved. Please try again.");
			return false;
		}
	};

	// Enter after the last crop: the layer's answer is its rating from the crops (stored again when
	// your crop answers changed it), then the next step
	const onDone = async () => {
		if (!rating || disabled) return;
		const verdict = QUALITY_VERDICT[rating.quality];
		if (myAnswer(people, user?.id, runId, { checkKey, layer })?.verdict !== verdict) {
			try {
				await save([{ check_key: checkKey, dataset_id: datasetId, run_id: runId, layer, label_id: labelOf(layer), verdict, details: { from_crops: true } }]);
			} catch {
				message.error("Your answer was not saved. Please try again.");
				return;
			}
		}
		onNextStep();
	};

	return (
		<CropReviewer
			crops={crops.map((c) => ({ id: c.id, flagged: calls.get(c.id) === "major" }))}
			layers={[layer as PredictionLayer]}
			imageOf={(id, kind) => modelViewImage(evidence, id, kind)}
			automated={evidence.automated}
			mine={(id, l) => myAnswer(people, user?.id, runId, { checkKey, layer: l, cropId: id })}
			checkMajor={(id, l) => cropMajor(evidence, id, l)}
			cropId={cropId}
			onSelectCrop={onSelectCrop}
			onAnswer={onAnswer}
			onDone={() => void onDone()}
			onShowMap={onShowMap}
			active
			disabled={disabled}
			header={
				<div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="crop-review-header">
					<span className="text-base font-semibold">{section.title}</span>
					{rating && <LayerRatingLine rating={rating} extra={`you answered ${answered} of ${crops.length}`} />}
				</div>
			}
		/>
	);
}
