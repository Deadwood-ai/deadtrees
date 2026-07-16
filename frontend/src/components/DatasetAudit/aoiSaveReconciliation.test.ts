import { describe, expect, it } from "vitest";

import { type AOIGeometry, reconcileAOISave } from "./aoiSaveReconciliation";

const polygon = (offset: number): AOIGeometry => ({
	type: "Polygon",
	coordinates: [[
		[offset, offset],
		[offset + 1, offset],
		[offset + 1, offset + 1],
		[offset, offset],
	]],
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
