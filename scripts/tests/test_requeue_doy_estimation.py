import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from requeue_doy_estimation import MODEL_VERSION, needs_estimate  # noqa: E402

from shared.asset_manifest import DOY_ESTIMATION_MODEL_DIR_NAME  # noqa: E402

DATASET = {'aquisition_year': 2023, 'aquisition_month': 6, 'aquisition_day': 15}


def estimate(model_version: str = DOY_ESTIMATION_MODEL_DIR_NAME, **fields) -> dict:
	return {
		'model_version': model_version,
		'model_type': 's2',
		'recorded_year': 2023,
		'recorded_month': 6,
		'recorded_day': 15,
		'metadata': {},
		**fields,
	}


class RequeueDoyEstimationTest(unittest.TestCase):
	def test_current_model_version_is_the_shipped_asset(self) -> None:
		self.assertEqual(MODEL_VERSION, DOY_ESTIMATION_MODEL_DIR_NAME)

	def test_estimate_of_the_previous_model_is_requeued(self) -> None:
		self.assertEqual(needs_estimate(DATASET, estimate('doy_estimation_v1'), MODEL_VERSION, False), 'model_version')

	def test_current_estimate_of_the_same_date_is_kept(self) -> None:
		self.assertIsNone(needs_estimate(DATASET, estimate(), MODEL_VERSION, False))

	def test_missing_and_changed_dates_are_requeued(self) -> None:
		self.assertEqual(needs_estimate(DATASET, None, MODEL_VERSION, False), 'missing')
		self.assertEqual(needs_estimate(DATASET, estimate(recorded_day=1), MODEL_VERSION, False), 'date_changed')


if __name__ == '__main__':
	unittest.main()
