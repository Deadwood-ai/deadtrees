"""Versioned rules that turn stored crop answers into a per-layer dataset verdict.

A rule reads only stored per-crop answers, so a new rule version is recomputed without model
calls. Rule v1 uses the exclude set (the tiles with the most predicted cover): on the 59 DT-1272
benchmark datasets "2 or more of 10 crops major" caught 68% of Bad forest layers and wrongly
excluded 10% of good ones; deadwood is still below target and waits for the retune with the
open adjudications. The training set's weighted major share is reported as an estimate only.
"""

from __future__ import annotations

from typing import Sequence

RULE_VERSION = 'pq-rule-v1'
# Crop is major when the judges' mean major likelihood reaches this (calibrated on the gold set,
# 13 Oct: at most 10% of the reviewer's non-major crops above it).
RULE_CONFIG = {'crop_major_cut': {'deadwood': 52.0, 'forest': 69.0}, 'min_major_crops': 2}


def crop_major(layer: str, combined: dict, config: dict = RULE_CONFIG) -> bool | None:
	score = combined.get('major_likelihood')
	return None if score is None else score >= config['crop_major_cut'][layer]


def dataset_verdict(
	layer: str, exclude_crops: Sequence[dict], training_crops: Sequence[dict] = (), config: dict = RULE_CONFIG
) -> dict:
	"""exclude_crops / training_crops: dicts with 'combined' (judge.combined) and, for training, 'weight'.

	Returns the layer verdict ('bad' or 'ok', or None when no crop could be judged) with the
	numbers it rests on, for the rule row and the review page. `config` is the version's
	(`CONFIG['rule_config']`), so a registered version runs with the cuts it was registered with.
	"""

	def is_major(crop):
		return crop_major(layer, crop['combined'], config)

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
