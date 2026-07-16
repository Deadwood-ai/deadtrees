import { describe, expect, it } from "vitest";

import {
	type AOIGeometry,
	isSameAOIGeometry,
	reconcileAOIChange,
	reconcileAOISave,
} from "./aoiSaveReconciliation";

const polygon = (offset: number): AOIGeometry => ({
	type: "Polygon",
	coordinates: [[
		[offset, offset],
		[offset + 1, offset],
		[offset + 1, offset + 1],
		[offset, offset],
	]],
});

describe("isSameAOIGeometry", () => {
	it("recognizes an equivalent geometry republished by the map", () => {
		expect(isSameAOIGeometry(polygon(0), polygon(0))).toBe(true);
	});

	it("distinguishes a manual draft from the saved geometry", () => {
		expect(isSameAOIGeometry(polygon(0), polygon(2))).toBe(false);
	});
});

describe("reconcileAOIChange", () => {
	it("refreshes the saved baseline when the map republishes server geometry", () => {
		const previousSaved = polygon(0);
		const refreshedServer = polygon(2);

		expect(reconcileAOIChange(
			refreshedServer,
			previousSaved,
			refreshedServer,
		)).toEqual({
			savedGeometry: refreshedServer,
			isDirty: false,
		});
	});

	it("keeps a manual geometry dirty against the saved baseline", () => {
		const saved = polygon(0);
		const draft = polygon(2);

		expect(reconcileAOIChange(draft, saved, saved)).toEqual({
			savedGeometry: saved,
			isDirty: true,
		});
	});
});

describe("reconcileAOISave", () => {
	it("marks the submitted draft clean when no newer edits exist", () => {
		const submitted = polygon(0);
		const saved = polygon(0);

		expect(reconcileAOISave(submitted, submitted, saved)).toEqual({
			currentGeometry: saved,
			isDirty: false,
			hasNewerEdits: false,
		});
	});

	it("preserves and keeps a newer draft dirty", () => {
		const submitted = polygon(0);
		const current = polygon(2);
		const saved = polygon(0);

		expect(reconcileAOISave(current, submitted, saved)).toEqual({
			currentGeometry: current,
			isDirty: true,
			hasNewerEdits: true,
		});
	});
});
