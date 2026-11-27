import { useEffect, useMemo } from "react";
import { message } from "antd";
import { useSaveTileReview } from "../../../hooks/useAuditChecks";
import type { IAuditCheckEvidence, IAuditReviews, ITileJudgement, TileReviewInput } from "../../../types/auditChecks";
import type { IAuditSectionDef } from "../../../utils/auditChecks";
import CropReviewer from "../review/CropReviewer";
import { OVERLAY } from "../review/CropAnswerPanel";
import { useBenchmarkToggle } from "../benchmark/useBenchmarkToggle";
import { modelViewImage } from "./auditCheckView";

export interface AuditCropReviewProps {
	datasetId: number;
	/** the open prediction step: one layer */
	section: IAuditSectionDef;
	evidence: IAuditCheckEvidence;
	/** the tile calls and the reviews they rest on */
	reviews: IAuditReviews | undefined;
	/** each model's answer per tile and layer */
	judgements: ITileJudgement[];
	cropId: number | null;
	onSelectCrop: (cropId: number) => void;
	onShowMap: () => void;
	/** on to the audit's next step */
	onNextStep: () => void;
	disabled: boolean;
}

/** A prediction step's tiles in the crop review, over the map; each answer is stored at once as a
 * tile review on the prediction shown. The layer itself never needs review. B adds the tile to
 * the layer's benchmark, labeled with your answer, or takes it out again (operators). */
export default function AuditCropReview({ datasetId, section, evidence, reviews, judgements, cropId, onSelectCrop, onShowMap, onNextStep, disabled }: AuditCropReviewProps) {
	const { mutateAsync: save } = useSaveTileReview();
	const layer = section.layer!;
	const calls = useMemo(() => new Map((reviews?.tileCalls ?? []).filter((c) => c.layer === layer).map((c) => [c.tile_id, c])), [reviews, layer]);
	const benchmark = useBenchmarkToggle(layer, datasetId);
	const tiles = evidence.tiles;
	const first = tiles[0];

	useEffect(() => {
		if (cropId === null && first) onSelectCrop(first.id);
		// only when the review opens: a tile picked later stays
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const onAnswer = async (id: number, answer: Pick<TileReviewInput, "verdict" | "problems">, inBenchmark: boolean) => {
		try {
			// the answer judges the prediction the tile shows
			const prediction = modelViewImage(evidence, id, OVERLAY[layer])?.prediction_label_id ?? null;
			await save({ ...answer, dataset_id: datasetId, tile_id: id, layer, prediction_label_id: prediction, in_benchmark: inBenchmark });
			return true;
		} catch {
			message.error("Your crop answer was not saved. Please try again.");
			return false;
		}
	};

	return (
		<CropReviewer
			crops={tiles.map((t) => ({ id: t.id, verdict: calls.get(t.id)?.verdict ?? null }))}
			layer={layer}
			imageOf={(id, kind) => modelViewImage(evidence, id, kind)}
			judgements={judgements}
			decidingJudgement={(id) => calls.get(id)?.judgement_id ?? null}
			mine={(id) => reviews?.tileReviews.find((r) => r.id === calls.get(id)?.review_id) ?? null}
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
