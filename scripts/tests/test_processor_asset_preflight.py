import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shared.asset_manifest import PHENOLOGY_ASSET_PATH
from scripts.processor_asset_preflight import missing_assets


class ProcessorAssetPreflightTest(unittest.TestCase):
	def test_preflight_follows_canonical_model_checkpoint(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			assets_dir = Path(tmp_dir)
			with patch('shared.asset_manifest.DEADWOOD_V1_MODEL_CHECKPOINT_NAME', 'replacement.safetensors'):
				missing = missing_assets(assets_dir)

			self.assertIn(assets_dir / 'models/replacement.safetensors', missing)

	def test_nonempty_partial_phenology_store_is_missing(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			assets_dir = Path(tmp_dir)
			store = assets_dir / PHENOLOGY_ASSET_PATH
			store.mkdir(parents=True)
			(store / '.fixture').write_text('partial\n')

			missing = missing_assets(assets_dir)

			self.assertIn(store / '.zmetadata', missing)
			self.assertIn(store / 'phenology', missing)
