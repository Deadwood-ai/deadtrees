import type { IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import type { IAuditSectionDef } from "../../../utils/auditChecks";
import LayerRatingLine from "./LayerRatingLine";
import { useLayerRating } from "./useLayerRating";

interface CropAnswersProps {
	/** the prediction step whose check judged the crops */
	section: IAuditSectionDef;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
}

/** A prediction step in the sidebar: the layer rating that follows from the crops (the page puts
 * it into the saved audit once you answer, utils/cropAnswers answeredValues) and how far you are. The crops themselves are answered in the crop review. */
export default function CropAnswers({ section, evidence, people }: CropAnswersProps) {
	const { calls, crops, rating, answered } = useLayerRating(section, evidence, people);
	const flagged = crops.filter((c) => calls.get(c.id) === "major").length;

	if (!crops.length) return <div className="text-xs text-gray-500">This check stored no crops.</div>;
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white p-2.5" data-testid="audit-crop">
			{rating && <LayerRatingLine rating={rating} extra="your answers, else the check's · goes into the audit" />}
			<div className="text-xs text-gray-600">
				{flagged} of {crops.length} crops flagged by the check · you answered {answered}
			</div>
		</div>
	);
}
