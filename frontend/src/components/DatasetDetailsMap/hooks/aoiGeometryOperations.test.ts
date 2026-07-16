import Polygon from "ol/geom/Polygon";
import { describe, expect, it } from "vitest";

import {
	clipAOIGeometries,
	cutAOIGeometry,
	mergeAOIGeometries,
} from "./aoiGeometryOperations";

const square = (minX: number, minY: number, maxX: number, maxY: number) =>
	new Polygon([[
		[minX, minY],
		[maxX, minY],
		[maxX, maxY],
		[minX, maxY],
		[minX, minY],
	]]);

describe("AOI geometry operations", () => {
	it("merges overlapping polygons into one AOI polygon", () => {
		const merged = mergeAOIGeometries(
			square(0, 0, 10, 10),
			square(5, 0, 15, 10),
		);

		expect(merged).toHaveLength(1);
		expect(merged?.[0].getArea()).toBe(150);
	});

	it("clips the smaller polygon from the larger polygon", () => {
		const clipped = clipAOIGeometries(
			square(0, 0, 10, 10),
			square(5, 0, 10, 5),
		);

		expect(clipped).toHaveLength(1);
		expect(clipped?.[0].getArea()).toBe(75);
	});

	it("cuts a drawn hole from a selected polygon", () => {
		const cut = cutAOIGeometry(
			square(0, 0, 10, 10),
			square(2, 2, 8, 8),
		);

		expect(cut).toHaveLength(1);
		expect(cut?.[0].getArea()).toBe(64);
		expect(cut?.[0].getLinearRingCount()).toBe(2);
	});
});
