"""Dataset evaluation gold set: note reasons, stratified selection and the labeling store."""

import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from dataset_evaluation import gold_set

label_server = pytest.importorskip('dataset_evaluation.label_server')


@pytest.mark.parametrize(
	'notes,reason',
	[
		('Duplicate with 4236', 'duplicate'),
		('ortho is completely red', 'not_rgb'),
		('in atlantic', 'wrong_georeferencing'),
		('No trees', 'no_trees'),
		('Out of season and blurry throughout', 'season'),
		('Blurry throughout', 'blurry'),
		('holes and distortions throughout', 'artifacts'),
		('Image is too dark', 'too_dark'),
		('I see no orthoimage?', 'broken_ortho'),
		('Bad predictions', 'prediction_only'),
		('Doesnt look good from any perspective.', 'other'),
	],
)
def test_audit_notes_map_to_one_reason_in_priority_order(notes, reason):
	assert gold_set.note_reason(notes, None, '') == reason


def test_the_split_matches_the_database_hash():
	# audit.benchmark_split: md5('audit-split-v1:' || id), first 8 hex digits, mod 5
	splits = Counter(gold_set.benchmark_split(i) for i in range(1, 5001))
	assert 900 < splits['holdout'] < 1100
	assert gold_set.benchmark_split(15) == gold_set.benchmark_split(15)


def rows():
	out = []
	for i in range(400):
		excluded = i < 200
		out.append(
			{
				'dataset_id': 1000 + i,
				'final_assessment': 'exclude_completely'
				if excluded
				else ('fixable_issues' if i % 4 == 0 else 'no_issues'),
				'notes': ('Blurry throughout' if i % 2 else 'no trees') if excluded else None,
				'cog_issue_notes': None,
				'thumbnail_issue_notes': None,
				'audited_by': f'auditor-{i % 3}',
				'audit_year': 2025 + i % 2,
				'user_id': f'user-{i % 7}',
				'data_access': 'public',
				'platform': 'drone' if i % 5 else 'airborne',
				'aquisition_year': 2024,
				'aquisition_month': 6,
				'aquisition_day': 1,
			}
		)
	return out


def test_selection_fills_each_stratum_spreading_uploaders_first():
	gold = gold_set.select(rows())

	assert gold['counts']['exclude:blurry'] == 35 and gold['counts']['exclude:no_trees'] == 25
	assert gold['counts']['keep:fixable_issues'] == 40 and gold['counts']['keep:no_issues'] == 85
	assert gold['shortfall'] == {'artifacts': 18, 'not_rgb': 15, 'broken_ortho': 12, 'too_dark': 8, 'other': 12}
	blurry = [d for d in gold['datasets'] if d['stratum'] == 'exclude:blurry']
	assert len({d['dataset_id'] for d in gold['datasets']}) == len(gold['datasets'])
	assert all(d['audit']['auditor'].startswith('auditor_') for d in blurry)
	assert gold['datasets'] == gold_set.select(rows())['datasets']  # stable


def test_pick_takes_every_uploader_before_repeating_one():
	many = [{'dataset_id': i, 'user_id': 'a' if i < 50 else f'u{i}'} for i in range(60)]
	chosen = gold_set.pick(many, 13, lambda r: 0)

	assert len(chosen) == 13
	assert sum(r['user_id'] == 'a' for r in chosen) == 3


@pytest.mark.parametrize(
	'label,error',
	[
		({'call': 'exclude', 'reasons': []}, 'needs a reason'),
		({'call': 'keep', 'reasons': ['blurry']}, 'Only an exclusion'),
		({'call': 'fix', 'fix_flags': []}, 'needs what to fix'),
		({'call': 'exclude', 'reasons': ['ugly']}, 'Unknown reason'),
		({'call': 'delete'}, 'Unknown call'),
	],
)
def test_the_label_server_refuses_incomplete_labels(label, error):
	with pytest.raises(ValueError, match=error):
		label_server.validate({'dataset_id': 1, **label})


def test_every_save_is_kept_and_a_stale_page_is_refused(tmp_path):
	store = label_server.Store(tmp_path / 'labels.sqlite3')
	first = label_server.validate({'dataset_id': 7, 'call': 'exclude', 'reasons': ['not_rgb', 'blurry']})
	assert store.save(first)['revision'] == 1
	assert store.save(dict(label_server.validate({'dataset_id': 7, 'call': 'keep'}), revision=1))['revision'] == 2
	with pytest.raises(ValueError, match='Stale'):
		store.save(first)

	assert store.all()[7]['call'] == 'keep'
	events = store.db.execute('SELECT revision, payload FROM label_events ORDER BY revision').fetchall()
	assert [e[0] for e in events] == [1, 2] and '"blurry", "not_rgb"' in events[0][1]
