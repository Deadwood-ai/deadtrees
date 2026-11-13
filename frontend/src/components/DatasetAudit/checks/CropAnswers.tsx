import { useEffect } from "react";
import { Button, Form } from "antd";
import type { IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import type { IAuditSectionDef } from "../../../utils/auditChecks";
import { QUALITY_WORDS, useLayerRating } from "./useLayerRating";

interface CropAnswersProps {
	/** the prediction step whose check judged the crops */
	section: IAuditSectionDef;
	evidence: IAuditCheckEvidence;
	people: IAuditAssessment[];
	/** the step is open: its crops are in the crop review, or on the map */
	open: boolean;
	mapOnly: boolean;
	onShowCrops: () => void;
}

/** A prediction step in the sidebar: the layer rating that follows from the crops, which goes into
 * the saved audit, and how far you are. The crops themselves are answered in the crop review. */
export default function CropAnswers({ section, evidence, people, open, mapOnly, onShowCrops }: CropAnswersProps) {
	const { calls, crops, rating, answered } = useLayerRating(section, evidence, people);
	const flagged = crops.filter((c) => calls.get(c.id) === "major").length;

	// the layer's saved rating follows from the crops: your answers, else the check's calls
	const form = Form.useFormInstance();
	const field = section.fields[0];
	useEffect(() => {
		if (rating && field && form.getFieldValue(field) !== rating.quality) form.setFieldsValue({ [field]: rating.quality });
	}, [rating?.quality, field, form]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!crops.length) return <div className="text-xs text-gray-500">This check stored no crops.</div>;
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-white p-2.5" data-testid="audit-crop">
			{rating && (
				<div className="text-xs" data-testid="audit-layer-rating">
					Layer rating from the crops: <b>{QUALITY_WORDS[rating.quality]}</b>
					<span className="text-gray-500">
						{" "}
						· {rating.major} major of {rating.counted} counted crops (your answers, else the check's) · goes into the audit
					</span>
				</div>
			)}
			<div className="text-xs text-gray-600">
				{flagged} of {crops.length} crops flagged by the check · you answered {answered}
			</div>
			{open && mapOnly && (
				<Button size="small" type="primary" ghost onClick={onShowCrops}>
					Back to the crop review (M)
				</Button>
			)}
			{open && !mapOnly && <div className="text-[11px] text-gray-500">The crops are open next to this panel.</div>}
		</div>
	);
}
