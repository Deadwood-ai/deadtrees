"""Turn a day-of-year distribution into the audit-facing assessment.

Rules (thresholds calibrated on out-of-fold predictions of the deployed
recipes; see docs/doy-estimation.md for the numbers):

- predicted date: circular median of the distribution in the flight year;
- modes: arcs of the 90 % highest-density set holding >= 10 % probability
  each. More than one is a "multiple bumps" distribution (evergreen tropics,
  spring/autumn confusion) where a far-away recorded date can still be right;
- huge mismatch: the recorded date (or recorded month) lies outside the 99 %
  set, is >= 60 days from the predicted date, and the distribution has a
  single mode;
- suggested date: the predicted date, when the month is missing or on a huge
  mismatch;
- accept recommendation: a suggestion is recommended when the distribution
  has a single mode and its 80 % set spans <= 90 days.
"""

import calendar
import datetime as dt
from dataclasses import dataclass, field

import numpy as np

from .circular import (
	NBINS,
	arc_bins,
	bin_to_date,
	circ_diff,
	circular_median_bin,
	days_in_year,
	doy_to_bin,
	hdi_mask,
	mask_to_arcs,
	surprise,
)

HDI_LEVELS = (0.5, 0.8, 0.95, 0.99)
MODE_HDI_MASS = 0.9
MODE_MIN_MASS = 0.10
MISMATCH_SURPRISE = 0.99
MISMATCH_MIN_DAYS = 60.0
ACCEPT_MAX_HDI80_DAYS = 90.0


@dataclass
class DoyAssessment:
	predicted_date: dt.date
	mode_date: dt.date
	hdi: dict[str, list[list[str]]]
	hdi80_days: int
	n_modes: int
	recorded_precision: str  # day | month | year
	recorded_surprise: float | None
	recorded_offset_days: float | None
	is_mismatch: bool
	suggested_date: dt.date | None
	suggestion_reason: str | None  # missing_month | mismatch
	recommend_accept: bool | None
	details: dict = field(default_factory=dict)


def recorded_bins(year: int, month: int | None, day: int | None) -> np.ndarray | None:
	"""Bins covered by the recorded date: one bin for a full date, the month's
	bins when only year and month are known, None when the month is missing."""
	if not month:
		return None
	if day:
		return np.array([int(np.floor(doy_to_bin(dt.date(year, month, day).timetuple().tm_yday, year))) % NBINS])
	first = dt.date(year, month, 1).timetuple().tm_yday
	last = first + calendar.monthrange(year, month)[1] - 1
	lo = int(np.floor(doy_to_bin(first, year)))
	hi = int(np.floor(doy_to_bin(last, year)))
	return np.arange(lo, hi + 1) % NBINS


def count_modes(p: np.ndarray) -> int:
	mask = hdi_mask(p, MODE_HDI_MASS)
	return sum(1 for arc in mask_to_arcs(mask) if p[arc_bins(arc)].sum() >= MODE_MIN_MASS)


def hdi_date_ranges(p: np.ndarray, year: int, mass: float) -> list[list[str]]:
	"""HDI arcs as [start, end] ISO dates; arcs over New Year are split so each
	range stays inside the flight year."""
	parts = []
	for a, b in mask_to_arcs(hdi_mask(p, mass)):
		parts += [(a, b)] if a <= b else [(0, b), (a, NBINS - 1)]
	return [[bin_to_date(a, year).isoformat(), bin_to_date(b, year).isoformat()] for a, b in sorted(parts)]


def assess(p: np.ndarray, year: int, month: int | None, day: int | None) -> DoyAssessment:
	p = np.asarray(p, np.float64)
	p = p / p.sum()
	med = circular_median_bin(p)
	predicted = bin_to_date(med, year)
	hdi80_days = int(round(hdi_mask(p, 0.8).sum() * days_in_year(year) / NBINS))
	n_modes = count_modes(p)

	rec = recorded_bins(year, month, day)
	precision = 'day' if (month and day) else 'month' if month else 'year'
	rec_surprise = rec_offset = None
	is_mismatch = False
	if rec is not None:
		rec_surprise = min(surprise(p, b) for b in rec)
		offsets = np.abs(circ_diff(med + 0.5, rec + 0.5)) * days_in_year(year) / NBINS
		rec_offset = float(offsets.min())
		is_mismatch = rec_surprise >= MISMATCH_SURPRISE and rec_offset >= MISMATCH_MIN_DAYS and n_modes <= 1

	reason = 'missing_month' if rec is None else 'mismatch' if is_mismatch else None
	confident = n_modes <= 1 and hdi80_days <= ACCEPT_MAX_HDI80_DAYS
	return DoyAssessment(
		predicted_date=predicted,
		mode_date=bin_to_date(int(p.argmax()), year),
		hdi={f'{int(m * 100)}': hdi_date_ranges(p, year, m) for m in HDI_LEVELS},
		hdi80_days=hdi80_days,
		n_modes=n_modes,
		recorded_precision=precision,
		recorded_surprise=None if rec_surprise is None else round(rec_surprise, 4),
		recorded_offset_days=None if rec_offset is None else round(rec_offset, 1),
		is_mismatch=is_mismatch,
		suggested_date=predicted if reason else None,
		suggestion_reason=reason,
		recommend_accept=confident if reason else None,
		details={
			'rule': {
				'mismatch_surprise': MISMATCH_SURPRISE,
				'mismatch_min_days': MISMATCH_MIN_DAYS,
				'mode_hdi_mass': MODE_HDI_MASS,
				'mode_min_mass': MODE_MIN_MASS,
				'accept_max_hdi80_days': ACCEPT_MAX_HDI80_DAYS,
			}
		},
	)
