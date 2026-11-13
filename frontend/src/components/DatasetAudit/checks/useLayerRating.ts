import { useMemo } from "react";
import { useAuth } from "../../../hooks/useAuthProvider";
import type { IAuditAssessment, IAuditCheckEvidence } from "../../../types/auditChecks";
import type { IAuditSectionDef } from "../../../utils/auditChecks";
import { myCropVerdict } from "../../../utils/cropAnswers";
import { cropCalls, cropsForReview, layerRatingFromCrops } from "../../../utils/cropCalls";

/** A prediction step's crops and the layer rating that follows from them: the check's call on
 * each crop, the review order (flagged first) and the rating from your answers, else the check's
 * calls. The sidebar and the crop review read the same. */
export function useLayerRating(section: IAuditSectionDef, evidence: IAuditCheckEvidence, people: IAuditAssessment[]) {
	const { user } = useAuth();
	const calls = useMemo(() => cropCalls(evidence, section.layers), [evidence, section.layers]);
	const crops = useMemo(() => cropsForReview(evidence, calls), [evidence, calls]);
	const layer = section.layers[0];
	const mine = myCropVerdict(people, user?.id, evidence.run.id, layer);
	const rating = layerRatingFromCrops(evidence, calls, mine);
	const answered = crops.filter((c) => mine(c.id) !== null).length;
	return { calls, crops, rating, answered, layer };
}

export const QUALITY_WORDS = { great: "Great", sentinel_ok: "OK", bad: "Bad" } as const;
