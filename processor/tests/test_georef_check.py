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
	e = measure_reference('esri', *_matches(shift_m), footprint, edge, GRID)

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
	e = measure_reference('esri', a, b, scores, footprint, edge, GRID)

	assert not e.qualified and e.reason == 'no_fit' and e.matrix is None


@pytest.mark.unit
def test_matches_clustered_in_one_corner_do_not_qualify():
	footprint, edge = _footprint()
	a, b, scores = _matches(4.0)
	a, b = a * 0.2, b * 0.2  # all within the top-left fifth of the image
	e = measure_reference('esri', a, b, scores, footprint, edge, GRID)

	assert not e.qualified and e.reason == 'clustered_matches'


def _ref(provider, vote, p90, support=0.95, edge=0.95):
	from processor.src.georef_check_v1.evidence import source_family

	return ReferenceEvidence(
		provider,
		source_family(provider),
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
	e = measure_reference('esri', a, b, scores, footprint, edge, GRID)
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
