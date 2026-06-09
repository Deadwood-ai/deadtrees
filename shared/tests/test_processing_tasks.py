from shared.models import TaskTypeEnum
from shared.processing_tasks import downstream_tasks_missing_geotiff, format_missing_geotiff_error


def test_downstream_tasks_missing_geotiff_returns_unsafe_tasks_in_request_order():
	missing = downstream_tasks_missing_geotiff(
		[
			TaskTypeEnum.thumbnail,
			TaskTypeEnum.metadata,
			TaskTypeEnum.deadwood_treecover_combined_v2,
		]
	)

	assert missing == (TaskTypeEnum.thumbnail, TaskTypeEnum.deadwood_treecover_combined_v2)


def test_downstream_tasks_missing_geotiff_allows_metadata_only():
	assert downstream_tasks_missing_geotiff([TaskTypeEnum.metadata]) == ()


def test_downstream_tasks_missing_geotiff_allows_downstream_when_geotiff_is_present():
	assert downstream_tasks_missing_geotiff([TaskTypeEnum.geotiff, TaskTypeEnum.thumbnail]) == ()


def test_format_missing_geotiff_error_names_unsafe_tasks():
	message = format_missing_geotiff_error((TaskTypeEnum.thumbnail, TaskTypeEnum.treecover_v1))

	assert 'require geotiff in the same processing request' in message
	assert 'thumbnail' in message
	assert 'treecover_v1' in message
