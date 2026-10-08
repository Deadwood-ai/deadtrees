"""Offline checks for selection tagging and the blind label store."""
import tempfile
import unittest
from pathlib import Path

from label_server import Store, validate
from select_benchmark import note_tags


def blank(dataset_id, revision=0):
    return {'dataset_id': dataset_id, 'revision': revision, 'note': '',
            'layers': {'deadwood': {'verdict': 'exclude', 'area': 'gt50', 'tags': ['omission']},
                       'forest_cover': {'verdict': 'keep', 'area': None, 'tags': []}}}


class NoteTags(unittest.TestCase):
    def test_layer_specific_modes(self):
        self.assertIn('omission', note_tags('deadwood', 'misses many burnt trees'))
        self.assertIn('disturbance', note_tags('deadwood', 'misses many burnt trees'))
        self.assertIn('confuser_snow_water', note_tags('deadwood', 'mistakes snow for deadwood'))
        self.assertEqual(note_tags('forest_cover', 'Doesnt exist'), ['missing_layer'])
        self.assertEqual(note_tags('forest_cover', ''), ['unspecified'])
        self.assertEqual(note_tags('deadwood', 'Check the prediction.'), ['other'])


class LabelStore(unittest.TestCase):
    def test_validation_rejects_unknown_values(self):
        bad = blank(1)
        bad['layers']['deadwood']['tags'] = ['made_up']
        with self.assertRaises(ValueError):
            validate(bad)
        bad = blank(1)
        bad['layers']['forest_cover']['verdict'] = 'great'
        with self.assertRaises(ValueError):
            validate(bad)

    def test_revisions_and_history(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / 'labels.sqlite3')
            first = store.save(validate(blank(7)))
            self.assertEqual(first['revision'], 1)
            with self.assertRaises(ValueError):
                store.save(validate(blank(7, revision=0)))  # stale tab
            second = store.save(validate(blank(7, revision=1)))
            self.assertEqual(second['revision'], 2)
            events = store.db.execute('SELECT count(*) FROM label_events WHERE dataset_id = 7').fetchone()[0]
            self.assertEqual(events, 2)
            reopened = Store(Path(d) / 'labels.sqlite3').all()
            self.assertEqual(reopened[7]['layers']['deadwood']['verdict'], 'exclude')


if __name__ == '__main__':
    unittest.main()
