"""The judge prompt, answer parsing, and how several judges' answers combine.

Prompt v5 = the DT-1272 benchmark prompt v4 (failure modes m1-m7, no m8, lying wood never
deadwood) with an area % next to each mode's likelihood, because adding the model's size to the
likelihood ranked the reviewer's major crops better on the gold set (plan, session 4). Model
calls are not made here: a backend is any function (prompt, images) -> answer text, so the
subscription worker (DT-1482) and the benchmark harness share the same prompt and parser.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Sequence

from PIL import Image

PROMPT_VERSION = 'pq-v5'
LAYERS = ('deadwood', 'forest')
VERDICTS = ('ok', 'minor', 'major')
MODES = {
	'deadwood': {
		'm1_dead_missed': 'Dead trees missed: clearly visible standing dead or dying trees (grey, white, burnt or brown), or large dead parts of crowns, have no blue.',
		'm2_dw_on_live_vegetation': 'Live vegetation marked dead: blue covers living trees, shrubs, grass or crops with green or coloured foliage.',
		'm3_dw_on_non_vegetation': 'Non-vegetation marked dead: blue covers ground, rock, roads, roofs, water, snow or deep shadow.',
		'm4_dw_on_lying_wood': 'Lying wood marked dead: blue covers lying trunks, logs or debris on the ground.',
		'm7_dw_artifact': 'Processing artifact in the deadwood layer: straight tile seams, rectangular holes or blocks, or the blue cut off or missing.',
	},
	'forest': {
		'm5_fc_trees_missed': 'Trees missed: clearly visible tree canopy has no gold.',
		'm6_fc_on_non_trees': 'Non-trees marked as forest: gold covers shrubs, crops, grass, bare ground or roofs, or fills open gaps between crowns.',
		'm7_fc_artifact': 'Processing artifact in the forest layer: straight tile seams, rectangular holes or blocks, or the gold cut off or missing.',
	},
}

_MODE_LINES = '\n'.join(f'- {k}: {text}' for layer in MODES.values() for k, text in layer.items())
_MODE_JSON = {
	layer: '{' + ', '.join(f'"{k}": {{"likelihood": n, "area_pct": n}}' for k in modes) + '}'
	for layer, modes in MODES.items()
}

PROMPT = f'''Aerial drone image crop, about 51 m by 51 m at about 5 cm per pixel. Image 1 is raw RGB,
Image 2 the DEADWOOD prediction (blue fill with outline), Image 3 the FOREST prediction (gold).
Darkened areas are outside the area of interest; ignore them.

Rules: deadwood means standing dead trees and dead parts of standing trees (grey, white, brown
or burnt crowns and branches); lying trunks, logs and debris are never deadwood. Forest means
all tree canopy (whether standing dead trees are included is not judged); grass, crops, low shrubs
and open gaps between crowns are not forest.

The predictions feed a satellite product that maps deadwood cover and forest cover per 10 m
pixel; this crop is 5 x 5 such pixels. Judge each layer separately. Compare the overlay with the
raw image region by region, list the errors you see, then give the verdict for that layer:
- "ok": no relevant error.
- "minor": errors exist, but together they would not noticeably change the satellite cover here.
- "major": all errors in this layer together would noticeably bias the satellite cover here, so
  this layer should be excluded.
Count overlapping errors once.
For each error type below, give its likelihood, 0 to 100, that the error is clearly present in the
layer, and area_pct, the share of the whole crop it affects (0 if absent):
{_MODE_LINES}
Also give major_likelihood, 0 to 100, that the layer has a major error.

Return only JSON: {{"assessable": true|false,
 "deadwood": {{"errors": ["..."], "modes": {_MODE_JSON['deadwood']}, "verdict": "ok|minor|major", "major_likelihood": n}},
 "forest": {{"errors": ["..."], "modes": {_MODE_JSON['forest']}, "verdict": "ok|minor|major", "major_likelihood": n}}}}'''

Backend = Callable[[str, Sequence[Image.Image]], str]


class AnswerError(ValueError):
	"""The judge's text is not a valid answer to the prompt."""


@dataclass
class LayerAnswer:
	verdict: str
	major_likelihood: float
	modes: dict = field(default_factory=dict)  # mode -> {'likelihood': float, 'area_pct': float}
	errors: list = field(default_factory=list)

	@property
	def area_pct(self) -> float:
		"""Error area over all modes, capped at 100 (modes may overlap)."""
		return min(100.0, sum(m['area_pct'] for m in self.modes.values()))


@dataclass
class Answer:
	judge: str
	assessable: bool
	layers: dict  # layer -> LayerAnswer
	raw: str


def _number(value, name) -> float:
	try:
		x = float(value)
	except (TypeError, ValueError):
		raise AnswerError(f'{name} is not a number') from None
	if not 0 <= x <= 100:
		raise AnswerError(f'{name} out of 0-100')
	return x


def parse(judge: str, text: str) -> Answer:
	"""Validate one judge's answer; unknown modes are dropped, missing modes count as absent."""
	found = re.search(r'\{.*\}', text, re.S)
	if not found:
		raise AnswerError('no JSON object')
	try:
		values = json.loads(found.group(0))
	except json.JSONDecodeError as e:
		raise AnswerError(f'invalid JSON: {e}') from None
	layers = {}
	for layer in LAYERS:
		v = values.get(layer)
		if not isinstance(v, dict) or v.get('verdict') not in VERDICTS:
			raise AnswerError(f'{layer}: missing or bad verdict')
		modes = {}
		for k in MODES[layer]:
			m = (v.get('modes') or {}).get(k) or {}
			if isinstance(m, (int, float)):  # older shape: likelihood only
				m = {'likelihood': m, 'area_pct': 0}
			modes[k] = {'likelihood': _number(m.get('likelihood', 0), k), 'area_pct': _number(m.get('area_pct', 0), k)}
		layers[layer] = LayerAnswer(
			verdict=v['verdict'],
			major_likelihood=_number(v.get('major_likelihood'), f'{layer} major_likelihood'),
			modes=modes,
			errors=[str(e)[:200] for e in (v.get('errors') or [])][:10],
		)
	return Answer(judge=judge, assessable=bool(values.get('assessable', True)), layers=layers, raw=text)


def ask(judge: str, backend: Backend, images: Sequence[Image.Image], retries: int = 1) -> Answer:
	"""One judge on one crop; a malformed answer is retried, then raised."""
	last = None
	for _ in range(retries + 1):
		text = backend(PROMPT, images)
		try:
			return parse(judge, text)
		except AnswerError as e:
			last = e
	raise last


def combined(answers: Sequence[Answer], layer: str) -> dict:
	"""The judges' answers for one layer, averaged: what the dataset rule reads."""
	present = [a.layers[layer] for a in answers]
	if not present:
		return {'major_likelihood': None, 'area_pct': None, 'judges': 0}
	n = len(present)
	return {
		'major_likelihood': sum(a.major_likelihood for a in present) / n,
		'area_pct': sum(a.area_pct for a in present) / n,
		'judges': n,
	}
