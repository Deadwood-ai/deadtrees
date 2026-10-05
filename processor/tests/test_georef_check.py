from datetime import date
from types import SimpleNamespace

import numpy as np
import pytest

from processor.src.georef_check_v1.check import GeorefCheck
from processor.src.georef_check_v1.evidence import (
	Assessment,
	Grid,
	ReferenceEvidence,
	combine,
	footprint_samples,
	measure_reference,
)
from processor.src.georef_check_v1.references import pick_wayback
from processor.src.process_georef_check import check_row, flight_date, suggestion_row

# a 1400 x 1000 px grid of 0.1 m pixels near Freiburg (EPSG:3857 metres; ~0.066 m on the ground)
GRID = Grid((870000.0, 6100000.0, 870140.0, 6100100.0), 1400, 1000)


def _matches(shift_m: float, n: int = 3000, seed: int = 0):
	"""Drone pixels spread over the grid and their reference positions, moved east by shift_m."""
	rng = np.random.default_rng(seed)
	a = np.column_stack((rng.uniform(0, GRID.width, n), rng.uniform(0, GRID.height, n)))
	b = a + np.array([shift_m / GRID.metres_per_pixel(), 0.0])
	return a, b, np.full(n, 0.9)


def _footprint():
	mask = np.zeros((GRID.height, GRID.width), bool)
	mask[50:-50, 50:-50] = True
	return footprint_samples(mask)


@pytest.mark.unit
@pytest.mark.parametrize('shift_m,vote', [(4.0, 'good'), (30.0, 'poor')])
def test_reference_measures_the_shift_and_votes_by_the_15m_line(shift_m, vote):
	footprint, edge = _footprint()
	e = measure_reference('esri', 'esri', *_matches(shift_m), footprint, edge, GRID)

	assert e.qualified and e.decides
	assert e.p90_m == pytest.approx(shift_m, abs=0.5)
	assert len(e.holdout_p90_m) == 4
	assert e.vote == vote
	assert e.support > 0.9 and 0 < len(e.sample_pairs) <= 200


@pytest.mark.unit
def test_few_confident_matches_give_no_fit():
	footprint, edge = _footprint()
	a, b, scores = _matches(4.0)
	scores[:] = 0.2  # RoMa is unsure everywhere, as on closed canopy
	e = measure_reference('esri', 'esri', a, b, scores, footprint, edge, GRID)

	assert not e.qualified and e.reason == 'no_fit' and e.matrix is None


@pytest.mark.unit
def test_matches_clustered_in_one_corner_do_not_qualify():
	footprint, edge = _footprint()
	a, b, scores = _matches(4.0)
	a, b = a * 0.2, b * 0.2  # all within the top-left fifth of the image
	e = measure_reference('esri', 'esri', a, b, scores, footprint, edge, GRID)

	assert not e.qualified and e.reason == 'clustered_matches'


def _ref(provider, vote, p90, support=0.95, edge=0.95):
	return ReferenceEvidence(
		provider,
		'esri' if provider.startswith('wayback') or provider == 'esri' else provider,
		vote=vote,
		p90_m=p90,
		support=support,
		edge_support=edge,
		qualified=True,
		decides=True,
	)


@pytest.mark.unit
def test_independent_agreeing_references_are_strong_and_a_wayback_capture_is_not_independent_of_esri():
	assert combine([_ref('esri', 'good', 3.0), _ref('google', 'good', 4.0)]).evidence_level == 'strong'
	same_family = combine([_ref('esri', 'good', 3.0), _ref('wayback-123', 'good', 4.0)])
	assert (same_family.decision, same_family.evidence_level, same_family.groups) == ('good', 'qualified', 1)


@pytest.mark.unit
def test_near_threshold_or_narrow_support_is_qualified_not_strong():
	assert combine([_ref('esri', 'good', 13.0), _ref('google', 'good', 4.0)]).evidence_level == 'qualified'
	assert (
		combine([_ref('esri', 'good', 3.0, edge=0.4), _ref('google', 'good', 4.0, edge=0.4)]).evidence_level
		== 'qualified'
	)


@pytest.mark.unit
def test_disagreeing_or_unstable_references_leave_the_call_uncertain():
	conflict = combine([_ref('esri', 'good', 3.0), _ref('google', 'poor', 22.0)])
	assert (conflict.decision, conflict.evidence_level, conflict.reason) == (
		'uncertain',
		'conflict',
		'references_disagree',
	)
	unstable = combine([_ref('esri', 'unstable', 14.5)])
	assert (unstable.decision, unstable.reason) == ('uncertain', 'unstable_near_threshold')
	assert combine([]).evidence_level == 'insufficient'


@pytest.mark.unit
def test_low_support_reference_qualifies_but_does_not_decide():
	footprint, edge = _footprint()
	a, b, scores = _matches(4.0)
	keep = (a[:, 0] < GRID.width * 0.45) & (a[:, 1] < GRID.height * 0.55)  # matches in one quarter only
	scores[~keep] = 0.0
	e = measure_reference('esri', 'esri', a, b, scores, footprint, edge, GRID)
	assert e.support < 0.30 and not e.decides


@pytest.mark.unit
def test_wayback_skips_the_current_imagery_and_prefers_the_capture_closest_to_the_flight():
	captures = [
		{'release': 9, 'capture_date': '2024-05-01'},
		{'release': 8, 'capture_date': '2021-06-10'},
		{'release': 7, 'capture_date': '2021-06-10'},  # same imagery in an older release
		{'release': 6, 'capture_date': '2018-07-01'},
		{'release': 5, 'capture_date': None},
	]
	# release 9 is what Esri World Imagery shows today
	assert [c['release'] for c in pick_wayback(captures, date(2021, 7, 1))] == [8, 6]
	assert [c['release'] for c in pick_wayback(captures, None)] == [6, 8]
	assert pick_wayback([{'release': 9, 'capture_date': '2024-05-01'}], None) == []
	assert pick_wayback([{'release': 1, 'capture_date': None}], None) == []


@pytest.mark.unit
def test_flight_date_falls_back_to_mid_month_or_july():
	assert flight_date(SimpleNamespace(aquisition_year=2023, aquisition_month=5, aquisition_day=20)) == date(
		2023, 5, 20
	)
	assert flight_date(SimpleNamespace(aquisition_year=2023, aquisition_month=5, aquisition_day=None)) == date(
		2023, 5, 15
	)
	assert flight_date(SimpleNamespace(aquisition_year=2023, aquisition_month=None, aquisition_day=None)) == date(
		2023, 7, 1
	)
	assert flight_date(SimpleNamespace(aquisition_year=None, aquisition_month=None, aquisition_day=None)) is None


def _check(decision, level, p90=3.0):
	refs = [_ref('esri', 'good' if decision == 'good' else 'poor', p90)]
	return GeorefCheck(
		assessment=Assessment(decision, level, 'references_agree', p90, 1, 0.95, 0.95),
		references=refs,
		reference_errors={'google': 'RuntimeError: Google session HTTP 403'},
		used_aoi=True,
		grid={'bounds_3857': list(GRID.bounds), 'width': GRID.width, 'height': GRID.height},
		seconds=9.5,
		details={'rules_version': 'georef-rules-v1', 'model_version': 'romav2.0.1'},
	)


@pytest.mark.unit
def test_good_or_poor_becomes_the_is_georeferenced_suggestion_and_uncertain_none():
	good = suggestion_row(7, _check('good', 'strong'))
	assert (good['field'], good['value'], good['reason'], good['source']) == (
		'is_georeferenced',
		True,
		'strong',
		'georef_check_v1',
	)
	assert good['details']['references'] == ['esri']
	assert suggestion_row(7, _check('poor', 'qualified', 22.0))['value'] is False
	assert suggestion_row(7, _check('uncertain', 'insufficient')) is None


@pytest.mark.unit
def test_check_row_keeps_versions_evidence_and_provider_errors():
	row = check_row(7, _check('poor', 'qualified', 22.0))
	assert (row['decision'], row['evidence_level'], row['p90_m'], row['rules_version']) == (
		'poor',
		'qualified',
		22.0,
		'georef-rules-v1',
	)
	assert row['reference_evidence'][0]['provider'] == 'esri'
	assert row['reference_errors'] == {'google': 'RuntimeError: Google session HTTP 403'}
	assert row['metadata']['seconds'] == 9.5


def _patch_check(monkeypatch, centre_lat, refs, first, retry=None):
	"""Run check.run_georef_check on a synthetic source with fixed matcher output:
	`first` for the unmasked pass, `retry` for the AOI-masked one."""
	import processor.src.georef_check_v1.check as check
	from processor.src.georef_check_v1.references import Reference
	from processor.src.georef_check_v1.source import Source

	half = 70.0
	y = 6378137 * np.log(np.tan(np.pi / 4 + np.radians(centre_lat) / 2))
	grid = Grid((870000.0 - half, y - 50, 870000.0 + half, y + 50), 1400, 1000)
	mask = np.zeros((grid.height, grid.width), bool)
	mask[50:-50, 50:-50] = True
	image = np.full((grid.height, grid.width, 3), 90, np.uint8)
	source = Source(grid, image, mask, 0.05, used_aoi=True)
	monkeypatch.setattr(check, 'read_source', lambda *args: source)
	monkeypatch.setattr(
		check,
		'fetch_references',
		lambda *args: ([Reference(p, p, image, 18) for p in refs], {} if refs else {'esri': 'ConnectionError'}),
	)
	calls = []

	def fake_match(drone, reference):
		masked = bool((drone[~mask] == 127).all()) and len(calls) >= len(refs)
		calls.append(masked)
		return (retry if masked else first)(grid)

	monkeypatch.setattr(check, 'match', fake_match)
	return check, calls


def _shifted(shift_m, confident=True):
	def make(grid):
		rng = np.random.default_rng(0)
		a = np.column_stack((rng.uniform(0, grid.width, 3000), rng.uniform(0, grid.height, 3000)))
		return a, a + np.array([shift_m / grid.metres_per_pixel(), 0.0]), np.full(3000, 0.9 if confident else 0.1)

	return make


@pytest.mark.unit
def test_an_uncertain_first_pass_is_retried_inside_the_aoi_and_kept_only_if_it_decides(monkeypatch):
	check, calls = _patch_check(monkeypatch, 48.0, ['esri'], first=_shifted(4.0, confident=False), retry=_shifted(4.0))
	result = check.run_georef_check('cog.tif', {'type': 'Polygon'}, None)
	assert calls == [False, True]
	assert (result.decision, result.details['aoi_masked_retry']) == ('good', True)

	check, calls = _patch_check(
		monkeypatch, 48.0, ['esri'], first=_shifted(4.0, confident=False), retry=_shifted(4.0, confident=False)
	)
	result = check.run_georef_check('cog.tif', {'type': 'Polygon'}, None)
	assert (result.decision, result.details['aoi_masked_retry']) == ('uncertain', False)


@pytest.mark.unit
def test_lost_coordinates_need_fetched_references_that_match_nothing_on_the_null_line(monkeypatch):
	nothing = _shifted(0.0, confident=False)
	check, _ = _patch_check(monkeypatch, 0.0, ['esri'], first=nothing, retry=nothing)
	assert (check.run_georef_check('cog.tif', None, None).assessment.evidence_level) == 'gross'
	# a provider outage on the equator is not evidence of lost coordinates
	check, _ = _patch_check(monkeypatch, 0.0, [], first=nothing, retry=nothing)
	assert check.run_georef_check('cog.tif', None, None).decision == 'uncertain'
	# nor is unmatched imagery a few kilometres from the equator (closed tropical canopy)
	check, _ = _patch_check(monkeypatch, 0.03, ['esri'], first=nothing, retry=nothing)
	assert check.run_georef_check('cog.tif', None, None).decision == 'uncertain'


@pytest.fixture
def georef_task(test_dataset_for_processing, standardized_local_ortho, test_processor_user):
	from shared.models import QueueTask, TaskTypeEnum

	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.cog, TaskTypeEnum.georef_check_v1],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.mark.comprehensive
def test_stage_stores_the_check_and_a_matching_audit_suggestion(georef_task, auth_token):
	"""Full stage on the test ortho with real reference tiles (network) and the
	matcher asset: a check row, the done flag, and a suggestion only for a call."""
	from shared.db import use_client
	from shared.settings import settings

	from processor.src.process_cog import process_cog
	from processor.src.process_georef_check import process_georef_check

	process_cog(georef_task, settings.processing_path)
	process_georef_check(georef_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		check = (
			client.table(settings.georef_checks_table)
			.select('*')
			.eq('dataset_id', georef_task.dataset_id)
			.execute()
			.data
		)
		status = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', georef_task.dataset_id).execute().data
		)
		suggestions = (
			client.table(settings.audit_suggestions_table)
			.select('*')
			.eq('dataset_id', georef_task.dataset_id)
			.eq('source', 'georef_check_v1')
			.execute()
			.data
		)
	assert status[0]['is_georef_check_done'] is True
	assert len(check) == 1 and check[0]['reference_evidence'], check
	if check[0]['decision'] == 'uncertain':
		assert suggestions == []
	else:
		assert [(s['field'], s['value']) for s in suggestions] == [('is_georeferenced', check[0]['decision'] == 'good')]


@pytest.mark.unit
def test_provider_registry_is_well_formed():
	from shared.settings import settings
	from processor.src.georef_check_v1.providers import REGISTRY

	names = [p.name for p in REGISTRY]
	assert len(names) == len(set(names))
	for p in REGISTRY:
		assert p.kind in ('xyz', 'wms', 'arcgis_export'), p.name
		assert p.url.startswith(('https://', 'http://')), p.name
		assert p.check_lonlat and p.covers(*p.check_lonlat), p.name
		if p.kind == 'xyz':
			assert '{q}' in p.url or ('{x}' in p.url and ('{y}' in p.url or '{-y}' in p.url)), p.name
		if p.kind == 'wms':
			assert p.wms_layers and p.wms_crs in ('EPSG:3857', 'EPSG:900913', 'EPSG:4326'), (
				p.name
			)  # 900913: legacy name of 3857
		if p.key_setting:
			assert hasattr(settings, p.key_setting), p.name
		else:
			assert p.licence, p.name  # every keyless service says what its terms are


@pytest.mark.unit
def test_tms_rows_are_flipped_and_keys_stay_out_of_the_viewer():
	from processor.src.georef_check_v1.providers import REGISTRY
	from processor.src.georef_check_v1.references import _viewer

	es = next(p for p in REGISTRY if p.name == 'es-pnoa-ma')
	assert _viewer(es) is None  # TMS row order is not offered to the browser
	assert all(_viewer(p) is None for p in REGISTRY if p.key_setting)
	wms = next(p for p in REGISTRY if p.name == 'de-bw-dop20')
	assert _viewer(wms)['kind'] == 'wms' and _viewer(wms)['layers'] == wms.wms_layers


@pytest.mark.unit
def test_quadkeys_and_ellipsoidal_mercator_rows():
	from processor.src.georef_check_v1.references import _ellipsoidal_bounds, quadkey

	assert quadkey(3, 5, 3) == '213'  # Bing's documented example
	# EPSG:3395 northings fall ~35 km short of 3857 ones at 55°N
	y = 7361866.0  # ~55.0°N in EPSG:3857
	_, south, _, north = _ellipsoidal_bounds(Grid((4.1e6, y - 100, 4.1e6 + 200, y + 100), 100, 100))
	assert 30_000 < (y - 100) - south < 40_000 and abs((north - south) - 200) < 1


@pytest.mark.unit
def test_matching_runs_at_highest_precision_and_restores_the_workers_setting(monkeypatch):
	"""The AOI stage leaves float32 matmul precision at 'high'; RoMa needs 'highest'."""
	import torch

	import processor.src.georef_check_v1.matcher as matcher

	seen = []

	class FakeRoma:
		def match(self, a, b):
			seen.append(torch.get_float32_matmul_precision())
			return None

		def sample(self, warp, n):
			return torch.zeros((1, 4)), torch.ones(1), None, None

		def to_pixel_coordinates(self, matches, *size):
			return torch.zeros((1, 2)), torch.zeros((1, 2))

	monkeypatch.setattr(matcher, 'load_matcher', lambda: FakeRoma())
	torch.set_float32_matmul_precision('high')
	try:
		matcher.match(np.zeros((8, 8, 3), np.uint8), np.zeros((8, 8, 3), np.uint8))
		assert seen == ['highest'] and torch.get_float32_matmul_precision() == 'high'
	finally:
		torch.set_float32_matmul_precision('highest')
