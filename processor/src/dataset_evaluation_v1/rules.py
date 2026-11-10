"""The deterministic parts of the dataset evaluation: band check, duplicate check and
the dataset rule that combines them with the model answers.

Each rule returns one dataset-level `rule` assessment (model = rule name,
prompt_version = rule version). The band and duplicate rules only flag: their worst
call is `unsure` (a person looks), except a band layout that cannot be an RGB photo.
"""

from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from .vocabulary import EXCLUDE_FLAGS, FIX_FLAGS, FLAGS

BAND_RULE = ('band_check', 'v1')
DUPLICATE_RULE = ('duplicates', 'v1')
DATASET_RULE = ('dataset-evaluation-rule', 'v1')
EMPTY_COG_RULE = ('empty_cog', 'v1')
PHASH_METHOD = 'phash-dct64-v1'


@dataclass
class Call:
	"""One assessor's dataset-level answer, as stored in audit.assessments."""

	assessor_kind: str  # 'model' or 'rule'
	model: str
	prompt_version: str
	verdict: str  # audit.verdict
	major_likelihood: float
	modes: dict = field(default_factory=dict)
	details: dict = field(default_factory=dict)
	raw: dict | None = None

	def row(self) -> dict:
		return {k: getattr(self, k) for k in self.__dataclass_fields__}


def verdict_for(likelihood: float, major_at: float = 90, unsure_at: float = 50) -> str:
	return 'major' if likelihood >= major_at else 'unsure' if likelihood >= unsure_at else 'ok'


# ---------------------------------------------------------------------------
# Band check
# ---------------------------------------------------------------------------


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


# A colour ratio is a guess (red soil and autumn foliage are red too): it sends the dataset
# to a person and never reaches the likelihood that excludes by rule.
COLOUR_GUESS_MAX = 85


def band_check(source_profile: dict | None, bands: np.ndarray, valid: np.ndarray) -> Call:
	"""Wrong bands, a single band, or multispectral data decoded wrongly.

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
	likelihood = round(float(likelihood), 1)
	return Call(
		assessor_kind='rule',
		model=BAND_RULE[0],
		prompt_version=BAND_RULE[1],
		verdict=verdict_for(likelihood),
		major_likelihood=likelihood,
		modes={'not_rgb': {'likelihood': likelihood}},
		details={
			'findings': [{'code': c, 'likelihood': round(float(lk), 1), 'why': why} for c, lk, why in findings],
			'source': {k: profile.get(k) for k in ('Bands', 'Dtype', 'ColorInterp')},
			'bands': stats,
		},
	)


# ---------------------------------------------------------------------------
# Duplicates
# ---------------------------------------------------------------------------

# How strongly each kind of match says "the same data uploaded again".
DUPLICATE_KINDS = {
	'same_file': 95,  # identical ortho sha256
	'same_image': 85,  # near-identical overview (perceptual hash) on overlapping footprints
	'same_flight_day': 70,  # same uploader, same date, overlapping footprints (a re-export or second flight)
}


def _dct_matrix(n: int) -> np.ndarray:
	k = np.arange(n)
	m = np.cos(np.pi * (2 * k[None, :] + 1) * k[:, None] / (2 * n)) * np.sqrt(2 / n)
	m[0] /= np.sqrt(2)
	return m


def phash(rgb: np.ndarray, valid: np.ndarray) -> int:
	"""64-bit perceptual hash of the overview (DCT of a 32 x 32 gray image), as a signed bigint."""
	gray = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
	gray[~valid] = gray[valid].mean() if valid.any() else 0
	small = np.asarray(Image.fromarray(gray).resize((32, 32), Image.BILINEAR), np.float64)
	d = _dct_matrix(32)
	low = (d @ small @ d.T)[:8, :8].flatten()
	bits = low > np.median(low[1:])
	value = int(''.join('1' if bit else '0' for bit in bits), 2)
	return value - (1 << 64) if value >= 1 << 63 else value


def hamming(a: int, b: int) -> int:
	return bin((a ^ b) & ((1 << 64) - 1)).count('1')


def duplicate_check(candidates: list[dict]) -> Call:
	"""Flag datasets that look like another upload of the same data; never excludes.

	`candidates` come from audit.duplicate_candidates: other datasets with the same
	file, a near-identical overview, or the same uploader and day, each with its
	footprint overlap.
	"""
	scored = sorted(
		({**c, 'likelihood': DUPLICATE_KINDS[c['kind']]} for c in candidates if c['kind'] in DUPLICATE_KINDS),
		key=lambda c: (-c['likelihood'], c['dataset_id']),
	)
	likelihood = float(scored[0]['likelihood']) if scored else 0.0
	return Call(
		assessor_kind='rule',
		model=DUPLICATE_RULE[0],
		prompt_version=DUPLICATE_RULE[1],
		verdict='unsure' if scored else 'ok',
		major_likelihood=likelihood,
		modes={'duplicate': {'likelihood': likelihood}},
		details={'candidates': scored[:20]},
	)


# ---------------------------------------------------------------------------
# Empty COG
# ---------------------------------------------------------------------------


def empty_cog(valid_share: float) -> Call:
	"""A COG without a usable image is a broken ortho: excluded by rule, no model asked."""
	return Call(
		assessor_kind='rule',
		model=EMPTY_COG_RULE[0],
		prompt_version=EMPTY_COG_RULE[1],
		verdict='major',
		major_likelihood=100.0,
		modes={'broken_ortho': {'likelihood': 100.0}},
		details={'reason': 'broken_ortho', 'valid_share': round(valid_share, 5), 'why': ['no_valid_pixels']},
	)


# ---------------------------------------------------------------------------
# Dataset rule
# ---------------------------------------------------------------------------

RULE_CONFIG = {
	'major_at': 60,  # mean model exclude likelihood that excludes
	'disagree_at': 50,  # spread between the models that sends the dataset to a person
	'fix_at': 50,  # mean fix-flag likelihood that makes a kept dataset "keep, fix"
}


def verdict_summary(why: list[str], models: list[Call], band: Call, duplicates: Call, mean: float) -> str:
	"""One sentence a reviewer reads next to the verdict: the cause in words, else what the surer model saw."""
	surest = max(models, key=lambda m: m.major_likelihood)
	said = str(surest.details.get('summary') or '').strip()
	votes = ', '.join(f'{m.model} {m.major_likelihood:.0f}' for m in models)
	parts = []
	for cause in why:
		if cause == 'band_check':
			finding = max(band.details.get('findings') or [{}], key=lambda f: f.get('likelihood', 0))
			parts.append(f'Not a true colour photo by the band check: {finding.get("why", "wrong bands")}')
		elif cause == 'models_disagree':
			parts.append(f'The models disagree on excluding it ({votes})')
		elif cause == 'model_unsure':
			parts.append('A model could not tell from the images')
		elif cause == 'model_excludes_below_threshold':
			parts.append(f'A model votes to exclude, but the average likelihood is only {mean:.0f} ({votes})')
		elif cause == 'duplicates':
			first = (duplicates.details.get('candidates') or [{}])[0]
			parts.append(
				f'Possible duplicate of dataset {first.get("dataset_id")} ({str(first.get("kind")).replace("_", " ")})'
			)
	if not parts:
		return said
	return '. '.join(parts) + ('. ' + said if said else '.')


def dataset_rule(models: list[Call], band: Call, duplicates: Call, config: dict = RULE_CONFIG) -> Call:
	"""The dataset verdict: the models averaged, overruled by a clear band failure,
	sent to a person when the models disagree or a rule flags."""
	likelihoods = [m.major_likelihood for m in models]
	mean = float(np.mean(likelihoods))
	spread = float(max(likelihoods) - min(likelihoods))
	modes = {
		k: {'likelihood': round(float(np.mean([m.modes.get(k, {}).get('likelihood', 0) for m in models])), 1)}
		for k in FLAGS
	}
	modes['not_rgb']['likelihood'] = max(modes['not_rgb']['likelihood'], band.major_likelihood)
	modes['duplicate'] = {'likelihood': duplicates.major_likelihood}
	fix = max(modes[k]['likelihood'] for k in FIX_FLAGS)
	why = []
	if band.verdict == 'major':
		verdict = 'major'
		why.append('band_check')
	elif any(m.verdict == 'unsure' for m in models) or spread >= config['disagree_at']:
		verdict = 'unsure'
		why.append('models_disagree' if spread >= config['disagree_at'] else 'model_unsure')
	elif mean >= config['major_at']:
		verdict = 'major'
		why.append('models_exclude')
	elif any(m.verdict == 'major' for m in models):
		# a model voted to exclude although the mean stays under the threshold: a person looks
		verdict = 'unsure'
		why.append('model_excludes_below_threshold')
	elif band.verdict == 'unsure' or duplicates.verdict == 'unsure':
		verdict = 'unsure'
		why += [c.model for c in (band, duplicates) if c.verdict == 'unsure']
	elif any(m.verdict == 'minor' for m in models) or fix >= config['fix_at']:
		verdict = 'minor'
		why.append('fix_flagged')
	else:
		verdict = 'ok'
	# The reason of the model that is surest the dataset should go, unless a rule is the cause.
	surest = max(models, key=lambda m: m.major_likelihood)
	if 'band_check' in why:
		reason = 'not_rgb'
	elif why == ['duplicates']:
		reason = 'duplicate'
	else:
		reason = surest.details.get('reason')
	return Call(
		assessor_kind='rule',
		model=DATASET_RULE[0],
		prompt_version=DATASET_RULE[1],
		verdict=verdict,
		major_likelihood=round(max(mean, band.major_likelihood if band.verdict == 'major' else 0), 1),
		modes=modes,
		details={
			'reason': reason if verdict in ('major', 'unsure') else None,
			'why': why,
			'summary': verdict_summary(why, models, band, duplicates, mean),
			'model_mean': round(mean, 1),
			'model_spread': round(spread, 1),
			'models': {m.model: m.verdict for m in models},
			'exclude_flags': {k: modes[k]['likelihood'] for k in EXCLUDE_FLAGS},
			'config': config,
		},
	)
