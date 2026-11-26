import { describe, expect, it } from "vitest";
import type { IAuditImage } from "../types/auditChecks";
import { nextOpen, stratified, targetKey, targetNoun, tileImages } from "./benchmarkLabels";

describe("stepping through a benchmark", () => {
	const targets = [1, 2, 3].map((id) => ({ id, label: id === 2 ? {} : null }));

	it("names a target in the URL by its tile or dataset, and calls them tiles or datasets", () => {
		expect(targetKey({ dataset_id: 7, tile_id: 70 })).toBe("tile-70");
		expect(targetKey({ dataset_id: 7, tile_id: null })).toBe("dataset-7");
		expect(targetNoun(true)).toBe("tiles");
		expect(targetNoun(false, 1)).toBe("dataset");
	});

	it("goes to the next target without a label, wrapping, and stops when none is left", () => {
		expect(nextOpen(targets, 1)?.id).toBe(3);
		expect(nextOpen(targets, 3)?.id).toBe(1);
		expect(nextOpen([targets[1], targets[0]], 1)).toBeNull();
	});
});

describe("stratified order", () => {
	it("takes one target per dataset in turn", () => {
		const t = (id: number, dataset_id: number) => ({ id, dataset_id });
		expect(stratified([t(1, 5), t(2, 5), t(3, 5), t(4, 6), t(5, 7), t(6, 7)]).map((x) => x.id)).toEqual([1, 4, 5, 2, 6, 3]);
		expect(stratified([])).toEqual([]);
	});
});

describe("a tile's images", () => {
	const image = (id: number, run_id: number, kind: IAuditImage["kind"], prediction_label_id: number | null = null) =>
		({ id, run_id, dataset_id: 5, tile_id: 70, kind, prediction_label_id, storage_path: `audit/${id}.jpg`, width: 1, height: 1 }) satisfies IAuditImage;
	// run 1 judged prediction 41, run 2 prediction 52; run 3 is the dataset evaluation, raw only
	const images = [image(1, 1, "raw"), image(2, 1, "deadwood_overlay", 41), image(3, 2, "raw"), image(4, 2, "deadwood_overlay", 52), image(5, 3, "raw")];

	it("are the newest run's raw image and overlay of the layer", () => {
		expect(tileImages(images, "deadwood", null).map((i) => i.id)).toEqual([3, 4]);
	});

	it("keep the picture of the prediction the label judged", () => {
		expect(tileImages(images, "deadwood", 41).map((i) => i.id)).toEqual([1, 2]);
	});

	it("fall back to a raw image without an overlay of the layer", () => {
		expect(tileImages(images, "forest_cover", null).map((i) => i.id)).toEqual([5]);
	});
});
