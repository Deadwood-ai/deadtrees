"""Versioned rule over the stored crop answers.

The crop call is what the audit uses: the deciding judge's verdict on the layer (Haiku; the other
judges are stored and shown, not counted). The audit counts each layer's crop calls in the
database with the deciding model of the version's config (`rule_config.decider`); the check stores
no dataset verdict. `dataset_verdict` summarises a layer for the benchmark runner
(scripts/qa/prediction-quality/run_check.py) only: "2 or more major crops in the exclude set" (the
tiles with the most predicted cover). The training set's weighted major share is reported as an
estimate only.
"""

from __future__ import annotations

from typing import Sequence

RULE_VERSION = 'pq-rule-v2'
# v2: the deciding model's verdict (v1 averaged the judges' major likelihood against a cut per layer)
RULE_CONFIG = {'decider': 'haiku', 'min_major_crops': 2}


def crop_major(combined: dict) -> bool | None:
	"""Whether the deciding judge called the crop major; None when it gave no call."""
	verdict = combined.get('verdict')
	return None if verdict in (None, 'ambiguous') else verdict == 'major'


def dataset_verdict(
	layer: str, exclude_crops: Sequence[dict], training_crops: Sequence[dict] = (), config: dict = RULE_CONFIG
) -> dict:
	"""exclude_crops / training_crops: dicts with 'combined' (judge.deciding) and, for training, 'weight'.

	Returns the layer verdict ('bad' or 'ok', or None when no crop could be judged) with the
	numbers it rests on, for the benchmark runner; nothing stores it.
	"""

	def is_major(crop):
		return crop_major(crop['combined'])

	judged = [c for c in exclude_crops if is_major(c) is not None]
	major = sum(1 for c in judged if is_major(c))
	verdict = None if not judged else ('bad' if major >= config['min_major_crops'] else 'ok')
	weighted = None
	trained = [c for c in training_crops if is_major(c) is not None and c.get('weight')]
	if trained:
		total = sum(c['weight'] for c in trained)
		weighted = sum(c['weight'] for c in trained if is_major(c)) / total
	return {
		'rule': RULE_VERSION,
		'verdict': verdict,
		'major_crops': major,
		'judged_crops': len(judged),
		'training_major_share': weighted,
	}
