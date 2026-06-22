"""Unit tests for the processor side of open-vocabulary tile search: building the
``insert_tile_embeddings`` rows and the background-prompt calibration sims.

No model weights or database are needed — the cached background-embedding bank is
stubbed, so the cosine math and the row formatting/rounding are exercised in
isolation.
"""

import numpy as np
import pytest

from processor.src import process_embeddings as pe
from processor.src.embedding_search import PatchEmbedding
from shared import embedding_model as em
from shared.embedding_model import BACKGROUND_PROMPTS, EMBEDDING_DIM

pytestmark = pytest.mark.unit


def test_embedding_to_pgvector_formats_six_decimals():
	assert pe._embedding_to_pgvector([0.1, -0.2, 0.333333]) == '[0.100000,-0.200000,0.333333]'


def test_embedding_to_pgvector_accepts_numpy_floats():
	arr = np.array([1.0, 2.5, -3.0], dtype=np.float32)
	assert pe._embedding_to_pgvector(arr) == '[1.000000,2.500000,-3.000000]'


def test_rows_from_embeddings_maps_fields_and_rounds():
	patch = PatchEmbedding(
		geo_bbox_4326=(8.10, 48.20, 8.25, 48.35),
		pixel_bbox=(0, 512, 512, 1024),
		embedding=np.array([0.5, -0.5], dtype=np.float32),
		nodata_fraction=0.123456,
	)
	bg_sims = [[0.111111111, 0.222222222, 0.5]]

	(row,) = pe._rows_from_embeddings([patch], bg_sims)

	assert (row['min_lon'], row['min_lat'], row['max_lon'], row['max_lat']) == (8.10, 48.20, 8.25, 48.35)
	assert (row['pixel_x0'], row['pixel_y0'], row['pixel_x1'], row['pixel_y1']) == (0, 512, 512, 1024)
	assert row['embedding'] == '[0.500000,-0.500000]'
	# nodata rounded to 4 dp, bg_sims to 6 dp.
	assert row['nodata_fraction'] == pytest.approx(0.1235)
	assert row['bg_sims'] == pytest.approx([0.111111, 0.222222, 0.5])


def test_rows_from_embeddings_are_index_aligned():
	patches = [
		PatchEmbedding((0, 0, 1, 1), (0, 0, 1, 1), np.array([1.0]), 0.0),
		PatchEmbedding((1, 1, 2, 2), (1, 1, 2, 2), np.array([2.0]), 0.0),
	]
	rows = pe._rows_from_embeddings(patches, [[0.1], [0.9]])

	assert rows[0]['bg_sims'] == pytest.approx([0.1])
	assert rows[1]['bg_sims'] == pytest.approx([0.9])
	assert rows[0]['embedding'] == '[1.000000]'
	assert rows[1]['embedding'] == '[2.000000]'


def test_tile_background_sims_equals_cosine_for_normalized(monkeypatch):
	# Stub the (normally model-derived) background bank: 2 prompts in 3-D.
	monkeypatch.setattr(em, '_BG_EMB', np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float32))
	emb = np.array([[1.0, 0.0, 0.0], [0.6, 0.8, 0.0]], dtype=np.float32)

	sims = em.tile_background_sims(emb)

	assert sims.shape == (2, 2)
	# cosine == dot product for L2-normalized vectors.
	np.testing.assert_allclose(sims, [[1.0, 0.0], [0.6, 0.8]], atol=1e-6)


def test_tile_background_sims_promotes_single_vector(monkeypatch):
	monkeypatch.setattr(em, '_BG_EMB', np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32))

	sims = em.tile_background_sims(np.array([1.0, 0.0], dtype=np.float32))

	assert sims.shape == (1, 2)
	np.testing.assert_allclose(sims[0], [1.0, 0.0], atol=1e-6)


def test_background_prompt_bank_is_locked():
	# bg_sims are stored per tile and the SQL softmax (tile_match_probability)
	# iterates over this exact bank; changing it silently invalidates every
	# stored row. Treat the count/dim as a deliberate tripwire: if you change the
	# prompt bank, you must re-embed (backfill bg_sims) and update this test.
	assert len(BACKGROUND_PROMPTS) == 6
	assert all(isinstance(p, str) and p.strip() for p in BACKGROUND_PROMPTS)
	assert EMBEDDING_DIM == 1024
