export type AOISource = "ml_prediction" | "manual" | "manual_correction";

export interface ExistingAOIIdentity {
	id: number;
	user_id: string;
	source: AOISource;
	corrected_from_aoi_id: number | null;
}

export type AOISaveTarget =
	| { kind: "update"; id: number }
	| {
		kind: "insert";
		source: "manual" | "manual_correction";
		correctedFromAOIId: number | null;
	};

export function resolveAOISaveTarget(
	latestAOI: ExistingAOIIdentity | undefined,
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
