export type AOISource = "ml_prediction" | "manual" | "manual_correction";

export interface ExistingAOI {
	id: number;
	user_id: string;
	source: AOISource;
	corrected_from_aoi_id: number | null;
	image_quality?: number | null;
	notes?: string | null;
}

export interface AOIMetadata {
	image_quality?: number | null;
	notes?: string | null;
}

export type AOISaveTarget =
	| { kind: "update"; id: number }
	| {
		kind: "insert";
		source: "manual" | "manual_correction";
		correctedFromAOIId: number | null;
	};

export function resolveAOISaveTarget(
	latestAOI: ExistingAOI | undefined,
	currentUserId: string,
): AOISaveTarget {
	if (
		latestAOI &&
		latestAOI.source !== "ml_prediction" &&
		latestAOI.user_id === currentUserId
	) {
		return { kind: "update", id: latestAOI.id };
	}

	if (latestAOI?.source === "ml_prediction") {
		return {
			kind: "insert",
			source: "manual_correction",
			correctedFromAOIId: latestAOI.id,
		};
	}

	if (latestAOI?.source === "manual_correction") {
		return {
			kind: "insert",
			source: "manual_correction",
			correctedFromAOIId: latestAOI.corrected_from_aoi_id,
		};
	}

	return {
		kind: "insert",
		source: "manual",
		correctedFromAOIId: null,
	};
}

export function resolveAOIRevisionMetadata(
	latestAOI: ExistingAOI | undefined,
	requestedMetadata: AOIMetadata,
): Required<AOIMetadata> {
	const canInheritManualMetadata = latestAOI?.source !== "ml_prediction";

	return {
		image_quality: requestedMetadata.image_quality !== undefined
			? requestedMetadata.image_quality
			: canInheritManualMetadata ? latestAOI?.image_quality ?? null : null,
		notes: requestedMetadata.notes !== undefined
			? requestedMetadata.notes
			: canInheritManualMetadata ? latestAOI?.notes ?? null : null,
	};
}
