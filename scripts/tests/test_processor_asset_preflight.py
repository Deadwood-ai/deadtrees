import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.processor_asset_preflight import missing_assets


class ProcessorAssetPreflightTest(unittest.TestCase):
	def test_preflight_follows_canonical_model_checkpoint(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			assets_dir = Path(tmp_dir)
			with patch('shared.asset_manifest.DEADWOOD_V1_MODEL_CHECKPOINT_NAME', 'replacement.safetensors'):
				missing = missing_assets(assets_dir)

			self.assertIn(assets_dir / 'models/replacement.safetensors', missing)
