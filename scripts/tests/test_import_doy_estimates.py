import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from import_doy_estimates import ESTIMATE_COLUMNS, check_bundle  # noqa: E402


def estimate(dataset_id: int = 1, **fields) -> dict:
	row = {c: None for c in ESTIMATE_COLUMNS}
	row.update(dataset_id=dataset_id, model_version='doy_estimation_v2', model_type='s2', probabilities=[1 / 365] * 365)
	return {**row, **fields}


class CheckBundleTest(unittest.TestCase):
	def test_a_bundle_as_the_stage_writes_it_passes(self) -> None:
		check_bundle({1: estimate()}, {2: {'dataset_id': 2}})

	def test_an_empty_bundle_is_refused(self) -> None:
		with self.assertRaises(SystemExit):
			check_bundle({}, {})

	def test_an_estimate_missing_a_column_is_refused(self) -> None:
		row = estimate()
		del row['hdi']
		with self.assertRaises(SystemExit):
			check_bundle({1: row}, {})

	def test_a_distribution_of_the_wrong_length_is_refused(self) -> None:
		with self.assertRaises(SystemExit):
			check_bundle({1: estimate(probabilities=[0.0] * 364)}, {})

	def test_a_dataset_both_estimated_and_cleared_is_refused(self) -> None:
		with self.assertRaises(SystemExit):
			check_bundle({1: estimate()}, {1: {'dataset_id': 1}})


if __name__ == '__main__':
	unittest.main()
