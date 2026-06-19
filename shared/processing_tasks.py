from shared.models import TaskTypeEnum


TASKS_REQUIRING_STANDARDIZED_ORTHO = frozenset(
	{
		TaskTypeEnum.cog,
		TaskTypeEnum.thumbnail,
		TaskTypeEnum.deadwood_v1,
		TaskTypeEnum.treecover_v1,
		TaskTypeEnum.deadwood_treecover_combined_v2,
		TaskTypeEnum.aoi_v1,
	}
)


def downstream_tasks_missing_geotiff(task_types: list[TaskTypeEnum]) -> tuple[TaskTypeEnum, ...]:
	"""Return downstream tasks that are unsafe without geotiff in the same job."""
	if TaskTypeEnum.geotiff in task_types:
		return ()
	return tuple(task_type for task_type in task_types if task_type in TASKS_REQUIRING_STANDARDIZED_ORTHO)


def format_missing_geotiff_error(task_types: tuple[TaskTypeEnum, ...]) -> str:
	task_names = ', '.join(task_type.value for task_type in task_types)
	return (
		'Downstream processing stages require geotiff in the same processing request '
		'because standardized orthos are transient and are not stored durably. '
		f'Add geotiff before rerunning: {task_names}.'
	)
