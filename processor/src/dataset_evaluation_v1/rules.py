"""The deterministic parts of the dataset evaluation: the band check and the dataset rule
that combines it with the model answers.

Each rule returns one dataset-level `rule` assessment (model = rule name,
prompt_version = rule version). The band check only flags: its worst call is `unsure`
(a person looks), except a band layout that cannot be an RGB photo.
"""

from dataclasses import dataclass, field

import numpy as np

from .vocabulary import EXCLUDE_FLAGS, FLAGS

BAND_RULE = ('band_check', 'v1')
# v3: the deciding model's answer (Haiku), no duplicate check and no "keep, fix": the verdict is ok,
# major or unsure, and the COG and thumbnail issues are the row's output whatever the verdict
DATASET_RULE = ('dataset-evaluation-rule', 'v3')
EMPTY_COG_RULE = ('empty_cog', 'v1')
# The issues a rule row reports as its output (audit.assessments.output), not as a verdict.
OUTPUT_FLAGS = ('cog_issue', 'thumbnail_issue')


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
	output: dict | None = None  # a rule row's values besides its verdict: {"cog_issue": bool, ...}

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
# Empty COG
# ---------------------------------------------------------------------------


def empty_cog(valid_share: float) -> Call:
	"""A COG without a usable image is a broken ortho: excluded by rule, no model asked, so
	no model raised a fix flag either."""
	return Call(
		assessor_kind='rule',
		model=EMPTY_COG_RULE[0],
		prompt_version=EMPTY_COG_RULE[1],
		verdict='major',
		major_likelihood=100.0,
		modes={'broken_ortho': {'likelihood': 100.0}},
		details={'reason': 'broken_ortho', 'valid_share': round(valid_share, 5), 'why': ['no_valid_pixels']},
		output=dict.fromkeys(OUTPUT_FLAGS, False),
	)


# ---------------------------------------------------------------------------
# Dataset rule
# ---------------------------------------------------------------------------

RULE_CONFIG = {
	'decider': 'haiku',  # the model whose answer decides (by name prefix); the others are shown only
	'fix_at': 50,  # COG or thumbnail issue likelihood of the deciding model that raises the flag
}


def decider_of(models: list[Call], config: dict) -> Call | None:
	return next((m for m in models if m.model.startswith(config['decider'])), None)


def verdict_summary(why: list[str], decider: Call | None, band: Call) -> str:
	"""One sentence a reviewer reads next to the verdict: the cause in words, else what the deciding model saw."""
	said = str(decider.details.get('summary') or '').strip() if decider else ''
	parts = []
	for cause in why:
		if cause == 'band_check':
			finding = max(band.details.get('findings') or [{}], key=lambda f: f.get('likelihood', 0))
			parts.append(f'Not a true colour photo by the band check: {finding.get("why", "wrong bands")}')
		elif cause == 'no_decider':
			parts.append('The deciding model gave no answer')
	if not parts:
		return said
	return '. '.join(parts) + ('. ' + said if said else '.')


def dataset_rule(models: list[Call], band: Call, config: dict = RULE_CONFIG) -> Call:
	"""The dataset verdict, ok, major or unsure: what the deciding model (Haiku) says, overruled only by
	a band layout that cannot be an RGB photo; unsure (a person looks) when it gave no answer. The other
	models are stored and shown, not counted. A model's "fix" counts as keep. The COG and thumbnail
	issues are the deciding model's, the row's output whatever the verdict."""
	decider = decider_of(models, config)
	modes = {k: {'likelihood': (decider.modes.get(k, {}).get('likelihood', 0) if decider else 0)} for k in FLAGS}
	modes['not_rgb']['likelihood'] = max(modes['not_rgb']['likelihood'], band.major_likelihood)
	why = []
	if band.verdict == 'major':
		verdict = 'major'
		why.append('band_check')
	elif decider is None:
		verdict = 'unsure'
		why.append('no_decider')
	else:
		verdict = 'ok' if decider.verdict == 'minor' else decider.verdict  # "fix" keeps the dataset
	reason = 'not_rgb' if 'band_check' in why else (decider.details.get('reason') if decider else None)
	return Call(
		assessor_kind='rule',
		model=DATASET_RULE[0],
		prompt_version=DATASET_RULE[1],
		verdict=verdict,
		major_likelihood=round(max(decider.major_likelihood if decider else 0, band.major_likelihood if band.verdict == 'major' else 0), 1),
		modes=modes,
		details={
			'reason': reason if verdict in ('major', 'unsure') else None,
			'why': why,
			'summary': verdict_summary(why, decider, band),
			'decider': decider.model if decider else None,
			'models': {m.model: m.verdict for m in models},
			'exclude_flags': {k: modes[k]['likelihood'] for k in EXCLUDE_FLAGS},
			'config': config,
		},
		output={k: modes[k]['likelihood'] >= config['fix_at'] for k in OUTPUT_FLAGS},
	)
