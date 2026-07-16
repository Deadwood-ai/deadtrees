import { describe, expect, it } from "vitest";

import {
	resolveAOIRevisionMetadata,
	resolveAOISaveTarget,
} from "./aoiSaveProvenance";

describe("resolveAOISaveTarget", () => {
	it("updates a manual correction owned by the current auditor", () => {
		expect(resolveAOISaveTarget({
			id: 12,
			user_id: "auditor-a",
			source: "manual_correction",
			corrected_from_aoi_id: 7,
		}, "auditor-a")).toEqual({ kind: "update", id: 12 });
	});

	it("creates a new correction for a different auditor", () => {
		expect(resolveAOISaveTarget({
			id: 12,
			user_id: "auditor-a",
			source: "manual_correction",
			corrected_from_aoi_id: 7,
		}, "auditor-b")).toEqual({
			kind: "insert",
			source: "manual_correction",
			correctedFromAOIId: 7,
		});
	});

	it("creates the first correction linked to a machine prediction", () => {
		expect(resolveAOISaveTarget({
			id: 7,
			user_id: "processor",
			source: "ml_prediction",
			corrected_from_aoi_id: null,
		}, "auditor-a")).toEqual({
			kind: "insert",
			source: "manual_correction",
			correctedFromAOIId: 7,
		});
	});

	it("creates an unlinked manual AOI when no prediction exists", () => {
		expect(resolveAOISaveTarget(undefined, "auditor-a")).toEqual({
			kind: "insert",
			source: "manual",
			correctedFromAOIId: null,
		});
	});
});

describe("resolveAOIRevisionMetadata", () => {
	it("preserves metadata when a different auditor creates a manual revision", () => {
		expect(resolveAOIRevisionMetadata({
			id: 12,
			user_id: "auditor-a",
			source: "manual_correction",
			corrected_from_aoi_id: 7,
			image_quality: 3,
			notes: "Keep this context",
		}, {})).toEqual({
			image_quality: 3,
			notes: "Keep this context",
		});
	});

	it("does not copy processor metadata from a machine prediction", () => {
		expect(resolveAOIRevisionMetadata({
			id: 7,
			user_id: "processor",
			source: "ml_prediction",
			corrected_from_aoi_id: null,
			image_quality: 2,
			notes: "model=v1",
		}, {})).toEqual({
			image_quality: null,
			notes: null,
		});
	});

	it("uses explicitly requested metadata instead of inherited values", () => {
		expect(resolveAOIRevisionMetadata({
			id: 12,
			user_id: "auditor-a",
			source: "manual",
			corrected_from_aoi_id: null,
			image_quality: 3,
			notes: "Old notes",
		}, {
			image_quality: null,
			notes: "New notes",
		})).toEqual({
			image_quality: null,
			notes: "New notes",
		});
	});
});
