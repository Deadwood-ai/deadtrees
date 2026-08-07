import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shared.asset_manifest import PHENOLOGY_ASSET_PATH
from shared.operator_env import load_env_file
from scripts.processor_asset_preflight import missing_assets, resolve_assets_dir


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

	def test_env_loader_preserves_dollar_pairs_and_shell_precedence(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			env_file = Path(tmp_dir) / '.env'
			env_file.write_text(
				'ASSET_ROOT=/from-file\n'
				'PROCESSOR_ASSETS_DIR=${ASSET_ROOT}/assets\n'
				'PROCESSOR_PASSWORD=prefix$$suffix\n'
				"LITERAL_PATH='$ASSET_ROOT/assets'\n"
			)
			with patch.dict(os.environ, {'ASSET_ROOT': '/from-shell'}):
				env = load_env_file(env_file)

			self.assertEqual(env['PROCESSOR_ASSETS_DIR'], '/from-shell/assets')
			self.assertEqual(env['PROCESSOR_PASSWORD'], 'prefix$$suffix')
			self.assertEqual(env['LITERAL_PATH'], '$ASSET_ROOT/assets')

	def test_empty_shell_assets_override_uses_compose_default(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			repo_dir = Path(tmp_dir)
			(repo_dir / '.env').write_text('PROCESSOR_ASSETS_DIR=/external/assets\n')

			with patch.dict(os.environ, {'PROCESSOR_ASSETS_DIR': ''}):
				assets_dir = resolve_assets_dir(repo_dir)

			self.assertEqual(assets_dir, (repo_dir / 'assets').resolve())

	def test_truncated_nonempty_checkpoint_is_missing(self) -> None:
		with tempfile.TemporaryDirectory() as tmp_dir:
			assets_dir = Path(tmp_dir)
			checkpoint = assets_dir / 'models/segformer_b5_full_epoch_100.safetensors'
			checkpoint.parent.mkdir(parents=True)
			checkpoint.write_bytes(b'partial')

			missing = missing_assets(assets_dir)

			self.assertIn(checkpoint, missing)
