from shared.models import TaskTypeEnum
from shared.processing_tasks import UPLOAD_TASK_TYPES, downstream_tasks_missing_geotiff, format_missing_geotiff_error


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


def test_upload_task_types_run_the_date_estimate_and_are_accepted_by_the_api():
	assert TaskTypeEnum.doy_estimation_v1 in UPLOAD_TASK_TYPES
	assert TaskTypeEnum.georef_check_v1 in UPLOAD_TASK_TYPES
	assert downstream_tasks_missing_geotiff(list(UPLOAD_TASK_TYPES)) == ()
