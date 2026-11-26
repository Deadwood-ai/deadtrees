import { Button } from "antd";
import type { IAuditDatasetResult, PredictionLayer } from "../../../types/auditChecks";
import { layerResult, type ILayerProgress } from "../../../utils/auditReview";
import LayerCounts from "../checks/LayerCounts";

interface PredictionStepProps {
	layer: PredictionLayer;
	result: IAuditDatasetResult | null | undefined;
	/** how far the tile answers go, once the check judged tiles of the layer */
	progress: ILayerProgress | null;
	/** the crop review is hidden behind the map: bring it back */
	onOpenCrops?: () => void;
}

/** Steps 6 and 7: a prediction layer's tiles as the audit counts them (Total, Major, Minor, OK;
 * a person's answer in place of the check's call) and how far the answers go. The layer never
 * needs review (a sample is reviewed instead); tiles answered in the crop review over the map
 * are stored at once. */
export default function PredictionStep({ layer, result, progress, onOpenCrops }: PredictionStepProps) {
	const counts = layerResult(result, layer);
	return (
		<div className="flex flex-col gap-2" data-testid={`audit-prediction-step-${layer}`}>
			<LayerCounts counts={counts && { ...counts, ambiguous: progress?.ambiguous }} />
			{progress && (
				<div className="rounded-lg bg-white p-2 text-xs text-gray-600" data-testid="audit-crop">
					<div>
						Answered {progress.answered} of {progress.crops} crops
					</div>
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
