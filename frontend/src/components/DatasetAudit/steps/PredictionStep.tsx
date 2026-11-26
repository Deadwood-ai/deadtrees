import { Button } from "antd";
import type { IAuditDatasetResult } from "../../../types/auditChecks";
import { layerResult, type ILayerReview, type PredictionReviewLayer } from "../../../utils/auditReview";
import LayerCounts from "../checks/LayerCounts";

interface PredictionStepProps {
	layer: PredictionReviewLayer;
	result: IAuditDatasetResult | null | undefined;
	/** your crop answers on the layer, once the check judged crops of it */
	review: ILayerReview | null | undefined;
	/** the crop review is hidden behind the map: bring it back */
	onOpenCrops?: () => void;
}

/** Steps 6 and 7: a prediction layer's crops as the check counts them (Total, Major, Minor, OK)
 * and how far your crop answers go. The layer never needs review (a sample is reviewed instead);
 * crops you answer in the crop review over the map are stored at once. */
export default function PredictionStep({ layer, result, review, onOpenCrops }: PredictionStepProps) {
	return (
		<div className="flex flex-col gap-2" data-testid={`audit-prediction-step-${layer}`}>
			<LayerCounts counts={layerResult(result, layer)} />
			{review && (
				<div className="rounded-lg bg-white p-2 text-xs text-gray-600" data-testid="audit-crop">
					<div>
						You answered {review.answered} of {review.crops} crops
					</div>
					{review.answered > 0 && <LayerCounts counts={review.counts} caption="with your answers" />}
					<div className="text-gray-500">No review needed. Answering crops is optional; each answer is stored at once.</div>
				</div>
			)}
			{onOpenCrops && (
				<Button size="small" onClick={onOpenCrops}>
					Open the crop review (M)
				</Button>
			)}
		</div>
	);
}
