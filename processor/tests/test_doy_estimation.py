import datetime as dt

import numpy as np
import pandas as pd
import pytest

from shared.models import Dataset

from processor.src.doy_estimation_v1 import assessment, circular, features
from processor.src.doy_estimation_v1.sentinel2 import S2Lookup, candidate_blocks
from processor.src.process_doy_estimation import estimate_row, select_aoi, suggestion_rows


def _peak(date: dt.date, sigma: float = 8.0) -> np.ndarray:
	return circular.wrapped_gaussian([circular.date_to_bin(date)], sigma)[0]


def _two_peaks(a: dt.date, b: dt.date, sigma: float = 8.0) -> np.ndarray:
	p = 0.55 * _peak(a, sigma) + 0.45 * _peak(b, sigma)
	return p / p.sum()


@pytest.mark.unit
def test_circular_date_round_trip_and_leap_year():
	assert circular.bin_to_date(0, 2024) == dt.date(2024, 1, 1)
	assert circular.bin_to_date(364, 2023) == dt.date(2023, 12, 31)
	# 365 bins squeeze a leap year: bin 364 starts on 30 December
	assert circular.bin_to_date(364, 2024) == dt.date(2024, 12, 30)
	b = int(np.floor(circular.date_to_bin(dt.date(2023, 7, 14))))
	assert circular.bin_to_date(b, 2023) == dt.date(2023, 7, 14)


@pytest.mark.unit
def test_hdi_arcs_wrap_over_new_year():
	p = _peak(dt.date(2021, 1, 1))
	arcs = circular.mask_to_arcs(circular.hdi_mask(p, 0.8))
	assert len(arcs) == 1
	start, end = arcs[0]
	assert start > end  # one arc crossing the year boundary
	ranges = assessment.hdi_date_ranges(p, 2021, 0.8)
	assert ranges[0][0] == '2021-01-01' and ranges[-1][1] == '2021-12-31'


@pytest.mark.unit
def test_recorded_date_far_from_unimodal_peak_is_a_mismatch():
	p = _peak(dt.date(2022, 7, 10))
	a = assessment.assess(p, 2022, 3, 24)
	assert a.n_modes == 1
	assert a.is_mismatch
	assert a.recorded_surprise > 0.99 and a.recorded_offset_days >= 60
	assert a.suggestion_reason == 'mismatch'
	assert abs((a.suggested_date - dt.date(2022, 7, 10)).days) <= 1
	assert a.recommend_accept is True  # one narrow mode


@pytest.mark.unit
def test_recorded_date_in_second_mode_is_not_a_mismatch():
	p = _two_peaks(dt.date(2022, 4, 1), dt.date(2022, 10, 1))
	a = assessment.assess(p, 2022, 10, 3)
	assert a.n_modes == 2
	assert not a.is_mismatch and a.suggested_date is None


@pytest.mark.unit
def test_far_date_with_two_modes_is_never_flagged():
	# the recorded date lies outside both modes, but the model is torn between
	# two seasons: the rule only trusts a single-mode distribution
	p = _two_peaks(dt.date(2022, 4, 1), dt.date(2022, 10, 1))
	a = assessment.assess(p, 2022, 1, 15)
	assert a.recorded_surprise > 0.99
	assert not a.is_mismatch


@pytest.mark.unit
def test_close_date_is_not_a_mismatch():
	a = assessment.assess(_peak(dt.date(2022, 7, 10)), 2022, 7, 1)
	assert not a.is_mismatch and a.suggestion_reason is None and a.recommend_accept is None


@pytest.mark.unit
def test_month_only_date_uses_the_best_day_of_the_month():
	p = _peak(dt.date(2022, 7, 28))
	assert not assessment.assess(p, 2022, 7, None).is_mismatch
	a = assessment.assess(p, 2022, 2, None)
	assert a.recorded_precision == 'month' and a.is_mismatch


@pytest.mark.unit
def test_missing_month_gets_a_suggestion_with_accept_recommendation_by_width():
	narrow = assessment.assess(_peak(dt.date(2022, 6, 1), sigma=10), 2022, None, None)
	assert narrow.suggestion_reason == 'missing_month' and narrow.recommend_accept is True
	assert narrow.recorded_surprise is None and not narrow.is_mismatch
	wide = assessment.assess(_peak(dt.date(2022, 6, 1), sigma=60), 2022, None, None)
	assert wide.hdi80_days > assessment.ACCEPT_MAX_HDI80_DAYS and wide.recommend_accept is False


@pytest.mark.unit
def test_candidate_blocks_follow_the_sentinel_grid():
	# Leipzig: block of the Sentinel pipeline's chunks table
	assert candidate_blocks(12.3223, 51.3617)[0] == ('block_32633_300000_5670000', 32633)
	# southern hemisphere uses the 326xx zone with negative northings; this
	# zone-edge site sits in the neighbouring zone's block in the real grid
	names = [n for n, _ in candidate_blocks(-47.88838, -22.22144)]
	assert 'block_32622_810000_-2490000' in names


@pytest.mark.unit
def test_select_aoi_prefers_auditor_aoi_and_ignores_whole_image():
	geom = {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
	manual = {**geom, 'coordinates': [[[0, 0], [2, 0], [2, 2], [0, 0]]]}
	aois = [
		{'geometry': geom, 'source': 'ml_prediction', 'is_whole_image': False, 'created_at': '2026-02-01'},
		{'geometry': manual, 'source': 'manual', 'is_whole_image': False, 'created_at': '2026-01-01'},
	]
	assert select_aoi(aois) == manual
	assert select_aoi([{'geometry': geom, 'source': 'manual', 'is_whole_image': True}]) is None
	assert select_aoi([]) is None


class _Estimate:
	def __init__(self, a, model_type='s2'):
		self.model_version = 'doy_estimation_v1'
		self.model_type = model_type
		self.probabilities = np.full(365, 1 / 365)
		self.assessment = a
		self.s2 = S2Lookup('ok', block='block_32633_300000_5670000', block_status='done')
		self.inputs = {'flight_year': 2022}


@pytest.mark.unit
def test_suggestion_rows_on_mismatch_preselect_bad_date_and_acceptance():
	est = _Estimate(assessment.assess(_peak(dt.date(2022, 7, 10)), 2022, 3, 24))
	rows = {r['field']: r for r in suggestion_rows(7, est)}
	assert rows['has_valid_acquisition_date']['value'] is False
	assert rows['accept_suggested_acquisition_date']['value'] is True
	assert rows['accept_suggested_acquisition_date']['details']['suggested_date'].startswith('2022-07')
	assert 'outside the 99% set' in rows['acquisition_date_notes']['value']
	assert all(r['source'] == 'doy_estimation_v1' for r in rows.values())


@pytest.mark.unit
def test_suggestion_rows_without_mismatch_preselect_good_date_only():
	est = _Estimate(assessment.assess(_peak(dt.date(2022, 7, 10)), 2022, 7, 5), model_type='nos2')
	rows = {r['field']: r for r in suggestion_rows(7, est)}
	assert rows['has_valid_acquisition_date']['value'] is True
	assert 'accept_suggested_acquisition_date' not in rows
	assert 'without Sentinel-2' in rows['acquisition_date_notes']['value']


@pytest.mark.unit
def test_estimate_row_records_model_version_type_and_assessed_date():
	a = assessment.assess(_peak(dt.date(2022, 7, 10)), 2022, 3, 24)
	dataset = Dataset(id=7, user_id='u', file_name='f.tif', license='CC BY', platform='drone', authors=['a'],
		aquisition_year=2022, aquisition_month=3, aquisition_day=24, data_access='public')
	row = estimate_row(7, dataset, _Estimate(a))
	assert row['model_version'] == 'doy_estimation_v1' and row['model_type'] == 's2'
	assert row['metadata']['model_type'] == 's2' and row['metadata']['s2']['block_status'] == 'done'
	assert (row['recorded_year'], row['recorded_month'], row['recorded_day']) == (2022, 3, 24)
	assert len(row['probabilities']) == 365 and row['suggestion_reason'] == 'mismatch'


@pytest.mark.unit
def test_s2_window_keeps_flight_year_weeks_and_positions():
	t = pd.date_range('2021-10-01', '2023-03-01', freq='7D').values.astype('datetime64[ns]')
	T = len(t)
	s2 = {
		'time': t,
		'series': np.full((T, 12), 1000.0, np.float32),
		'clear': np.ones(T, np.float32),
		'match': np.concatenate([np.full((T, 1), 0.9), np.full((T, 11), 0.5)], 1).astype(np.float32),
	}
	w = features.s2_window(s2, 2022)
	assert w['has_match']
	assert w['pos'].min() >= -35 * 365 / 365 and w['pos'].max() < 365 + 35
	assert w['f'].shape[1] == features.WEEK_FEATURES
	assert features.s2_window(s2, 2019) == {}


@pytest.mark.unit
def test_site_inputs_without_s2_sets_the_no_s2_site_facts():
	x = features.site_inputs(np.zeros((16, 1536), np.float16), {}, 51.0, 12.0, 2024, 0.03)
	assert x['static'].shape == (1, 10)
	assert x['static'][0, 7] == 0 and x['static'][0, 8] == 0  # has_s2, has_match
	assert not x['s2m'].any() and x['p10_valid'].all()


@pytest.mark.unit
def test_model_bundle_loads_and_predicts_a_distribution():
	from processor.src.doy_estimation_v1.model import load_bundle, predict_distribution
	from processor.src.doy_estimation_v1.predict_doy import MODEL_DIR

	if not (MODEL_DIR / 'manifest.json').exists():
		pytest.skip(f'acquisition-date model not found at {MODEL_DIR}; run `make download-doy-model`')
	bundle = load_bundle(MODEL_DIR, 'cpu')
	assert set(bundle.ensembles) == {'s2', 'nos2'}
	assert all(len(e.nets) == 5 for e in bundle.ensembles.values())
	x = features.site_inputs(np.zeros((16, 1536), np.float16), {}, 51.0, 12.0, 2024, 0.03)
	p, cal = predict_distribution(bundle.ensembles['nos2'], x, 'Temperate Broadleaf and Mixed Forests', 'cpu')
	assert p.shape == (365,) and abs(p.sum() - 1) < 1e-9
	assert cal['biome'] == 'Temperate Broadleaf and Mixed Forests'
