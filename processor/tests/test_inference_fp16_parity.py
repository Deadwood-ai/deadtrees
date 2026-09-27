"""fp16 GPU inference must keep the binarized masks of the fp32 models (>= 99%)."""

from itertools import islice
from pathlib import Path

import numpy as np
import pytest
import torch

from processor.src.utils.inference_dataset import InferenceDataset
from processor.src.utils.segmentation import image_reprojector
from shared.asset_manifest import COMBINED_MODEL_CHECKPOINT_NAME, DEADWOOD_V1_MODEL_CHECKPOINT_NAME

ASSETS_DIR = Path(__file__).parent.parent.parent / 'assets'
ORTHO = ASSETS_DIR / 'test_data' / 'test-data.tif'
N_TILES = 12
MIN_AGREEMENT = 0.99

pytestmark = [
	pytest.mark.slow,
	pytest.mark.skipif(not torch.cuda.is_available(), reason='fp16 inference only runs on the GPU'),
]


def _tiles() -> torch.Tensor:
	if not ORTHO.exists():
		pytest.skip(f'missing test ortho {ORTHO}')
	dataset = InferenceDataset(lambda: image_reprojector(str(ORTHO), min_res=0.05), 1024, 256, skip_nodata_tiles=True)
	return torch.from_numpy(np.stack([tile.image for tile in islice(dataset.tiles(), N_TILES)])).cuda()


def _assert_masks_agree(fp16: torch.Tensor, fp32: torch.Tensor, classes: list[int]):
	assert (fp16 == fp32).float().mean().item() >= MIN_AGREEMENT
	for cls in classes:
		a, b = fp32 == cls, fp16 == cls
		assert (a | b).any(), f'class {cls} absent from the test tiles'
		iou = (a & b).sum().item() / (a | b).sum().item()
		assert iou >= MIN_AGREEMENT, f'class {cls} IoU {iou:.4f}'


def _model_path(name: str) -> str:
	path = ASSETS_DIR / 'models' / name
	if not path.exists():
		pytest.skip(f'missing model weights {path}')
	return str(path)


def _as_fp32(inference):
	inference.model.float()
	inference.dtype = torch.float32
	return inference


def test_deadwood_fp16_matches_fp32():
	from processor.src.deadwood_segmentation_v1_moehring.inference.deadwood_inference import DeadwoodInference

	tiles = _tiles()
	path = _model_path(DEADWOOD_V1_MODEL_CHECKPOINT_NAME)
	fp16 = DeadwoodInference(path)
	assert fp16.dtype == torch.float16
	with torch.no_grad():
		fp16_masks = torch.cat([fp16.predict(batch) for batch in tiles.split(2)])
		del fp16
		fp32 = _as_fp32(DeadwoodInference(path))
		fp32_masks = torch.cat([fp32.predict(batch) for batch in tiles.split(2)])

	_assert_masks_agree(fp16_masks, fp32_masks, classes=[1])


def test_combined_fp16_matches_fp32():
	from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import (
		CLASS_DEADWOOD,
		CLASS_TREECOVER,
		CombinedInference,
	)

	tiles = _tiles()
	path = _model_path(COMBINED_MODEL_CHECKPOINT_NAME)
	fp16 = CombinedInference(path)
	assert fp16.dtype == torch.float16
	with torch.no_grad():
		fp16_classes = torch.cat([fp16.predict(batch) for batch in tiles.split(2)])
		del fp16
		fp32 = _as_fp32(CombinedInference(path))
		fp32_classes = torch.cat([fp32.predict(batch) for batch in tiles.split(2)])

	_assert_masks_agree(fp16_classes, fp32_classes, classes=[CLASS_TREECOVER, CLASS_DEADWOOD])
	# The treecover output binarizes as class > 0 (treecover or deadwood).
	_assert_masks_agree((fp16_classes > 0).to(torch.uint8), (fp32_classes > 0).to(torch.uint8), classes=[1])
