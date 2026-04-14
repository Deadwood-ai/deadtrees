import { IDataset } from "../types/dataset";

/**
 * Determines if a dataset should be visible on the public map/gallery.
 *
 * Requirements:
 * - Has COG (viewable on map)
 * - Has thumbnail (preview available)
 * - Has metadata with location info
 * - Either no error, OR error only from forest cover (inference failure is acceptable)
 */
export function isDatasetViewable(
	dataset: Pick<
		IDataset,
		| "is_cog_done"
		| "is_thumbnail_done"
		| "is_metadata_done"
		| "admin_level_1"
		| "has_error"
		| "is_deadwood_done"
		| "is_forest_cover_done"
	>
): boolean {
	const coreRequirements =
		dataset.is_cog_done &&
		dataset.is_thumbnail_done &&
		dataset.is_metadata_done &&
		dataset.admin_level_1;

	// Viewable if no error, OR if only forest cover failed
	const errorAcceptable =
		!dataset.has_error ||
		(dataset.is_deadwood_done && !dataset.is_forest_cover_done);

	return !!(coreRequirements && errorAcceptable);
}
