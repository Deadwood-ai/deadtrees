#!/usr/bin/env python3
"""Select the dataset evaluation gold set from production audits (read-only).

About 250 datasets: human exclusions with a visual reason, stratified by the reason
their audit notes give, and kept datasets as negatives, with fixable_issues as the
hard ones. The old audits are not truth: this set is what Janusch labels on the
dataset labeling page (label_server.py), and his labels become the benchmark.

Reads production only through the trusted analyst login in a read-only
transaction (docs/playbooks/analyst-database-access.md). Writes one JSON file:

	set -a; . ~/.config/deadtrees/monitor.env; set +a
	venv/bin/python scripts/dataset_evaluation/gold_set.py --out .local/dataset-evaluation/gold-set.json
"""

import argparse
import hashlib
import json
import os
import re
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

VERSION = 'gold-v1'

# Audit note categories, in priority order: the first match is the dataset's reason.
# Built from the 582 exclusion notes surveyed on 2026-10-27.
NOTE_PATTERNS = (
	('duplicate', r'duplic|dublic|\bdouble|same day|already (in|uploaded)|twice|copy of|part of [0-9]'),
	(
		'not_rgb',
		r'no(t)? rgb|completely red|wrong ba[n]?d comb|\bnir\b|thermal|multispec|channel|band|purple'
		r'|image is red|false colou?r|ndvi|gr[ae]yscale|infrared',
	),
	(
		'wrong_georeferencing',
		r'geoloc|georef|location|misalign|shift|offset|in atlantic|null island|not on the land'
		r'|ocean|wrong place|projection|\bcrs\b|coordinates',
	),
	(
		'no_trees',
		r'no tree|not a single tree|barely any tree|shu?rubs|mainly water|construction|not useful for dead'
		r'|no forest|not (a )?forest|not (a )?vegetat|urban|city|agricult|\bfield|water body|lake|meadow'
		r'|grassland|no vegetation|few trees',
	),
	('season', r'season|phenolog|leaf.?off|leafless|winter|snow|autumn|summer|deciduous|acquisition date'),
	('blurry', r'blur|image quality|low quality|poor quality|bad quality|resolution|pixelat|noisy|grainy|quality'),
	('artifacts', r'warp|distort|holes|bad recon|reconstruct|stitch|seam|artefact|artifact|smear|ghost|streak|mosaic'),
	('too_dark', r'dark|bright|overexpos|underexpos|shadow|cloud|haze|fog|exposure'),
	(
		'broken_ortho',
		r'processing|not loading|no imagery|not shown|empty|black|no data|nodata|corrupt|error'
		r'|does not have information|base map|incomplete|missing areas|see no ortho|faulty',
	),
	('prediction_only', r'prediction|segmentation|deadwood|forest cover'),
)
# What the models decide; duplicates, georeferencing and season belong to other checks.
VISUAL_REASONS = ('blurry', 'no_trees', 'artifacts', 'not_rgb', 'broken_ortho', 'too_dark', 'other')
EXCLUDED_TARGETS = {
	'blurry': 35,
	'no_trees': 25,
	'artifacts': 18,
	'not_rgb': 15,
	'broken_ortho': 12,
	'too_dark': 8,
	'other': 12,
}
KEPT_TARGETS = {'fixable_issues': 40, 'no_issues': 85}
MAX_PER_UPLOADER = 3  # per stratum, so one contributor's batch cannot fill a stratum


def note_reason(*notes: str | None) -> str:
	text = ' '.join(n for n in notes if n).lower()
	for reason, pattern in NOTE_PATTERNS:
		if re.search(pattern, text):
			return reason
	return 'other'


def benchmark_split(dataset_id: int) -> str:
	"""Same as audit.benchmark_split: 1 in 5 held out by a fixed hash of the id."""
	return (
		'holdout' if int(hashlib.md5(f'audit-split-v1:{dataset_id}'.encode()).hexdigest()[:8], 16) % 5 == 0 else 'dev'
	)


def order_key(dataset_id: int) -> str:
	return hashlib.sha256(f'dataset-evaluation-{VERSION}:{dataset_id}'.encode()).hexdigest()


def pick(rows: list[dict], target: int, stratum_of) -> list[dict]:
	"""Up to `target` rows in a stable hashed order, each sub-stratum (platform, year) in
	turn. At most MAX_PER_UPLOADER per uploader first; when that leaves the stratum short
	(exclusions come from few contributors), the rest fills it in the same order."""
	groups = defaultdict(list)
	for r in sorted(rows, key=lambda r: order_key(r['dataset_id'])):
		groups[stratum_of(r)].append(r)
	chosen, per_uploader = [], Counter()
	queues = [groups[k] for k in sorted(groups, key=lambda k: -len(groups[k]))]
	while len(chosen) < target and any(queues):
		for queue in queues:
			while queue:
				r = queue.pop(0)
				if per_uploader[r['user_id']] < MAX_PER_UPLOADER:
					per_uploader[r['user_id']] += 1
					chosen.append(r)
					break
			if len(chosen) >= target:
				break
	taken = {r['dataset_id'] for r in chosen}
	rest = [r for r in sorted(rows, key=lambda r: order_key(r['dataset_id'])) if r['dataset_id'] not in taken]
	return chosen + rest[: target - len(chosen)]


def select(rows: list[dict]) -> dict:
	"""The gold set from audited, processed, unarchived datasets."""
	excluded = defaultdict(list)
	kept = defaultdict(list)
	for r in rows:
		if r['final_assessment'] == 'exclude_completely':
			r['reason'] = note_reason(r['notes'], r['cog_issue_notes'], r['thumbnail_issue_notes'])
			excluded[r['reason']].append(r)
		elif r['final_assessment'] in KEPT_TARGETS:
			kept[r['final_assessment']].append(r)
	members, shortfall = [], {}
	for reason, target in EXCLUDED_TARGETS.items():
		chosen = pick(excluded[reason], target, lambda r: 0)
		shortfall[reason] = target - len(chosen)
		members += [dict(r, stratum=f'exclude:{reason}') for r in chosen]
	for assessment, target in KEPT_TARGETS.items():
		chosen = pick(kept[assessment], target, lambda r: (r['platform'], r['audit_year']))
		shortfall[assessment] = target - len(chosen)
		members += [dict(r, stratum=f'keep:{assessment}') for r in chosen]
	# Auditors appear under stable aliases, most audits first.
	auditors = Counter(r['audited_by'] for r in rows if r['audited_by'])
	alias = {a: f'auditor_{i + 1}' for i, (a, _) in enumerate(auditors.most_common())}
	datasets = [
		{
			'dataset_id': r['dataset_id'],
			'stratum': r['stratum'],
			'split': benchmark_split(r['dataset_id']),
			'data_access': r['data_access'],
			'platform': r['platform'],
			'acquisition': [r['aquisition_year'], r['aquisition_month'], r['aquisition_day']],
			'audit': {
				'final_assessment': r['final_assessment'],
				'reason': r.get('reason'),
				'notes': r['notes'],
				'cog_issue_notes': r['cog_issue_notes'],
				'thumbnail_issue_notes': r['thumbnail_issue_notes'],
				'year': r['audit_year'],
				'auditor': alias.get(r['audited_by']),
			},
		}
		for r in sorted(members, key=lambda r: order_key(r['dataset_id']))
	]
	return {
		'version': VERSION,
		'created_at': datetime.now(UTC).isoformat(timespec='seconds'),
		'targets': {
			**{f'exclude:{k}': v for k, v in EXCLUDED_TARGETS.items()},
			**{f'keep:{k}': v for k, v in KEPT_TARGETS.items()},
		},
		'available': {
			**{f'exclude:{k}': len(v) for k, v in excluded.items()},
			**{f'keep:{k}': len(v) for k, v in kept.items()},
		},
		'shortfall': {k: v for k, v in shortfall.items() if v > 0},
		'counts': dict(Counter(d['stratum'] for d in datasets)),
		'splits': dict(Counter(d['split'] for d in datasets)),
		'datasets': datasets,
	}


QUERY = """
SELECT a.dataset_id, a.final_assessment, a.notes, a.cog_issue_notes, a.thumbnail_issue_notes, a.audited_by,
	extract(year FROM a.audit_date)::int AS audit_year,
	d.user_id, d.data_access::text, d.platform::text, d.aquisition_year, d.aquisition_month, d.aquisition_day
FROM public.dataset_audit a
JOIN public.v2_datasets d ON d.id = a.dataset_id
JOIN public.v2_cogs c ON c.dataset_id = a.dataset_id
JOIN public.v2_orthos o ON o.dataset_id = a.dataset_id
JOIN public.v2_statuses s ON s.dataset_id = a.dataset_id
WHERE NOT coalesce(d.archived, false) AND s.is_cog_done AND NOT s.has_error
"""


@contextmanager
def analyst():
	"""The trusted read-only analyst connection, verified before any read."""
	import psycopg
	from psycopg.rows import dict_row

	uri = os.environ['DEADTREES_ANALYST_DATABASE_URL']
	if urlparse(uri).hostname != 'supabase.deadtrees.earth':
		raise ValueError('Unexpected production target')
	with psycopg.connect(uri, prepare_threshold=None, connect_timeout=10, autocommit=True) as db:
		db.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
		try:
			db.execute("SET LOCAL statement_timeout = '30s'")
			db.execute("SET LOCAL lock_timeout = '3s'")
			identity = db.execute(
				"SELECT current_database(), current_user, session_user, pg_has_role(current_user, 'analyst', 'MEMBER'), "
				"current_setting('transaction_read_only')"
			).fetchone()
			if identity != ('postgres', 'team_analyst', 'team_analyst', True, 'on'):
				raise RuntimeError('Unexpected analyst identity or transaction mode')
			db.row_factory = dict_row
			yield db
		finally:
			db.execute('ROLLBACK')


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--out', type=Path, required=True)
	args = parser.parse_args()
	with analyst() as db:
		rows = db.execute(QUERY).fetchall()
	gold = select(
		[dict(r, user_id=str(r['user_id']), audited_by=r['audited_by'] and str(r['audited_by'])) for r in rows]
	)
	args.out.parent.mkdir(parents=True, exist_ok=True)
	args.out.write_text(json.dumps(gold, indent=1, default=str) + '\n')
	print(json.dumps({k: gold[k] for k in ('counts', 'shortfall', 'splits', 'available')}, indent=1))


if __name__ == '__main__':
	main()
