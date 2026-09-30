"""Day-of-year helpers on the model's fixed 365-bin circle.

Bin b in [0, 365) covers the fraction [b/365, (b+1)/365) of the calendar year,
so leap years are squeezed by one day instead of getting a 366th class. These
are the conventions the model was trained with (research repo
side_projects/doy_estimation/common.py); keep them in one place.
"""

import calendar
import datetime as dt

import numpy as np

NBINS = 365
DAYS = np.arange(NBINS)


def days_in_year(year: int) -> int:
	return 366 if calendar.isleap(int(year)) else 365


def doy_to_bin(doy: float, year: int) -> float:
	"""1-based day of year -> continuous bin position in [0, 365)."""
	return (float(doy) - 1.0) * NBINS / days_in_year(year)


def date_to_bin(date: dt.date) -> float:
	return doy_to_bin(date.timetuple().tm_yday, date.year)


def bin_to_date(b: int, year: int) -> dt.date:
	doy = int(np.floor(b * days_in_year(year) / NBINS)) + 1
	return dt.date(int(year), 1, 1) + dt.timedelta(days=doy - 1)


def circ_diff(a, b):
	"""Signed circular difference a - b in bins, in (-182.5, 182.5]."""
	d = (np.asarray(a, float) - np.asarray(b, float)) % NBINS
	return np.where(d > NBINS / 2, d - NBINS, d)


def wrapped_gaussian(center, sigma):
	"""(len(center), 365) rows of a wrapped Gaussian, each summing to 1."""
	center = np.atleast_1d(np.asarray(center, float))
	d = circ_diff(DAYS[None, :] + 0.5, center[:, None])
	k = np.exp(-0.5 * (d / sigma) ** 2)
	return k / k.sum(1, keepdims=True)


_ABS_DIST = np.abs(circ_diff(DAYS[:, None], DAYS[None, :]))


def circular_median_bin(p: np.ndarray) -> int:
	"""Bin minimising the expected absolute circular error (the point estimate)."""
	return int((p @ _ABS_DIST).argmin())


def hdi_mask(p: np.ndarray, mass: float) -> np.ndarray:
	"""Smallest set of bins holding `mass` (may be several separate arcs)."""
	order = np.argsort(-p)
	k = int((np.cumsum(p[order]) < mass).sum()) + 1
	mask = np.zeros(NBINS, bool)
	mask[order[:k]] = True
	return mask


def mask_to_arcs(mask: np.ndarray) -> list[tuple[int, int]]:
	"""Contiguous circular arcs [(start_bin, end_bin_inclusive), ...] of a mask."""
	if mask.all():
		return [(0, NBINS - 1)]
	if not mask.any():
		return []
	off = int(np.argmin(mask))  # rotate so that index 0 is outside the set
	m = np.roll(mask, -off)
	arcs, start = [], None
	for i, v in enumerate(m):
		if v and start is None:
			start = i
		if not v and start is not None:
			arcs.append(((start + off) % NBINS, (i - 1 + off) % NBINS))
			start = None
	if start is not None:
		arcs.append(((start + off) % NBINS, (NBINS - 1 + off) % NBINS))
	return arcs


def arc_bins(arc: tuple[int, int]) -> np.ndarray:
	a, b = arc
	return np.arange(a, b + 1) if a <= b else np.r_[np.arange(a, NBINS), np.arange(0, b + 1)]


def surprise(p: np.ndarray, b: int) -> float:
	"""Probability of all days the model finds more likely than bin b."""
	return float(p[p > p[int(b) % NBINS]].sum())
