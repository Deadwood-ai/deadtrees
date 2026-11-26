"""The band check: wrong bands, a single band, or multispectral data decoded wrongly.

A measurement, not a verdict: the run stores its likelihood and findings in its evidence
(`band_check`), and the dataset evaluation's rules in the database exclude at their threshold
(`band_major_at`). A colour ratio is only a guess and stays below that threshold.
"""

import numpy as np


def band_stats(bands: np.ndarray, valid: np.ndarray) -> list[dict]:
	"""Mean, spread and 2nd/98th percentile of every band over the valid pixels."""
	stats = []
	for band in bands:
		v = band[valid].astype(np.float32)
		p2, p98 = np.percentile(v, (2, 98))
		stats.append(
			{'mean': round(float(v.mean()), 2), 'std': round(float(v.std()), 2), 'p2': float(p2), 'p98': float(p98)}
		)
	return stats


# A colour ratio is a guess (red soil and autumn foliage are red too): it never reaches the
# likelihood the rules exclude at.
COLOUR_GUESS_MAX = 85


def band_check(source_profile: dict | None, bands: np.ndarray, valid: np.ndarray) -> dict:
	"""Wrong bands, a single band, or multispectral data decoded wrongly, as the likelihood
	that the image is not an RGB photo with the findings it rests on.

	`source_profile` is the uploaded ortho's raster profile (v2_orthos.ortho_info
	Profile: Bands, Dtype, ColorInterp); `bands` are the COG bands at overview size.
	"""
	findings = []
	profile = source_profile or {}
	interp = [str(c).lower() for c in profile.get('ColorInterp') or []]
	colour_bands = [c for c in interp if c != 'alpha'] if interp else []
	if colour_bands and len(colour_bands) <= 2:
		findings.append(('single_band', 95, f'the upload has {len(colour_bands)} colour band(s)'))
	elif len(colour_bands) >= 5 or (
		colour_bands and set(colour_bands) <= {'gray', 'undefined'} and len(colour_bands) > 3
	):
		# The pipeline picks three bands; the image test below shows whether it picked RGB.
		findings.append(
			('multispectral_source', 40, f'the upload has {len(colour_bands)} bands ({profile.get("Dtype")})')
		)

	stats = band_stats(bands[:3], valid) if bands.shape[0] >= 3 else []
	if len(stats) == 3:
		pixels = bands[:3][:, valid].astype(np.float32)
		r, g, b = (s['mean'] for s in stats)
		if max(abs(r - g), abs(g - b), abs(r - b)) < 2 and np.abs(pixels - pixels.mean(axis=0)).mean() < 1.5:
			findings.append(('grayscale', 90, 'the three bands are the same'))
		else:
			# True colour vegetation and soil have red at most a little above green and blue.
			red = r / max(g, b, 1)
			if red >= 1.35:
				findings.append(
					(
						'false_colour_red',
						min(COLOUR_GUESS_MAX, 50 + (red - 1.35) * 150),
						f'red is {red:.2f}x green/blue',
					)
				)
			purple = min(r, b) / max(g, 1)
			if purple >= 1.35:
				findings.append(
					(
						'false_colour_purple',
						min(COLOUR_GUESS_MAX, 50 + (purple - 1.35) * 150),
						f'red and blue are {purple:.2f}x green',
					)
				)
	elif bands.shape[0] < 3:
		findings.append(('single_band', 95, f'the COG has {bands.shape[0]} band(s)'))

	likelihood = max((f[1] for f in findings if f[0] != 'multispectral_source'), default=0.0)
	if any(f[0] == 'multispectral_source' for f in findings):
		likelihood = max(likelihood, 40.0)
	return {
		'likelihood': round(float(likelihood), 1),
		'findings': [{'code': c, 'likelihood': round(float(lk), 1), 'why': why} for c, lk, why in findings],
		'source': {k: profile.get(k) for k in ('Bands', 'Dtype', 'ColorInterp')},
		'bands': stats,
	}
