from pathlib import Path

import numpy as np
import rasterio
import torch
import torch.nn.functional as F
from safetensors import safe_open
from torch.utils.data import DataLoader
from torchvision.transforms import transforms
from torchvision.transforms.functional import crop
from transformers import SegformerConfig, SegformerForSemanticSegmentation
from tqdm import tqdm

from processor.src.utils.inference_dataset import InferenceDataset
from processor.src.utils.segmentation import (
    filter_polygons_by_area,
    image_reprojector,
    mask_to_polygons,
    reproject_polygons,
)

CHECKPOINT_NAME = 'mitb3_seed200_ckpt_epoch_6_best_macro_f1.safetensors'

# Class indices as defined in the training config (config/base_segformer.yml)
CLASS_BACKGROUND = 0
CLASS_TREECOVER = 1
CLASS_DEADWOOD = 2

MINIMUM_INFERENCE_RESOLUTION = 0.05  # metres — match deadwood_v1
BATCH_SIZE = 2
NUM_DATALOADER_WORKERS = 0
MINIMUM_POLYGON_AREA = 0.1  # m²
TILE_SIZE = 1024
PADDING = 256


def _build_transform():
    return transforms.Compose(
        [
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ]
    )


def _build_model_config() -> SegformerConfig:
    # mit-b3 architecture (depths [3,4,18,3] confirmed from checkpoint inspection)
    return SegformerConfig(
        num_channels=3,
        num_encoder_blocks=4,
        depths=[3, 4, 18, 3],
        sr_ratios=[8, 4, 2, 1],
        hidden_sizes=[64, 128, 320, 512],
        patch_sizes=[7, 3, 3, 3],
        strides=[4, 2, 2, 2],
        num_attention_heads=[1, 2, 5, 8],
        mlp_ratios=[4, 4, 4, 4],
        hidden_act='gelu',
        hidden_dropout_prob=0.0,
        attention_probs_dropout_prob=0.0,
        classifier_dropout_prob=0.0,
        initializer_range=0.02,
        drop_path_rate=0.1,
        layer_norm_eps=1e-6,
        decoder_hidden_size=768,
        num_labels=3,
        id2label={0: 'background', 1: 'treecover', 2: 'deadwood'},
        label2id={'background': 0, 'treecover': 1, 'deadwood': 2},
        semantic_loss_ignore_index=255,
    )


class CombinedInference:
    """Runs the combined deadwood+treecover SegFormer-B3 model and returns
    separate polygon lists for each class."""

    def __init__(self, model_path: str):
        torch.set_float32_matmul_precision('high')
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = self._load_model(model_path)

    def _load_model(self, model_path: str) -> SegformerForSemanticSegmentation:
        # Checkpoint was saved from a wrapper class (self.model = ...), so all
        # keys are prefixed with "model.". Strip that prefix before loading.
        state_dict = {}
        with safe_open(model_path, framework='pt', device='cpu') as f:
            for key in f.keys():
                new_key = key[len('model.'):] if key.startswith('model.') else key
                state_dict[new_key] = f.get_tensor(key)

        model = SegformerForSemanticSegmentation(_build_model_config())
        model.load_state_dict(state_dict, strict=True)
        model = model.to(self.device)
        model.eval()
        return model

    def inference(self, input_tif: str) -> tuple[list, list]:
        """Run inference on a GeoTIFF and return (deadwood_polygons, treecover_polygons)
        in the CRS of the input file."""
        vrt_src = image_reprojector(input_tif, min_res=MINIMUM_INFERENCE_RESOLUTION)
        dataset = InferenceDataset(
            image_src=vrt_src,
            tile_size=TILE_SIZE,
            padding=PADDING,
            transform=_build_transform(),
        )
        vrt_src = dataset.image_src

        loader = DataLoader(
            dataset,
            batch_size=BATCH_SIZE,
            num_workers=NUM_DATALOADER_WORKERS,
            pin_memory=True,
            shuffle=False,
        )

        # Integer class map assembled from tiles
        class_map = np.zeros((dataset.height, dataset.width), dtype=np.int8)

        for images, cropped_windows in tqdm(loader, desc='combined inference'):
            images = images.to(self.device)

            with torch.no_grad():
                if images.shape[0] < BATCH_SIZE:
                    pad = torch.zeros((BATCH_SIZE, 3, TILE_SIZE, TILE_SIZE), dtype=torch.float32)
                    pad[: images.shape[0]] = images
                    pad = pad.to(self.device)
                    logits = self.model(pixel_values=pad).logits[: images.shape[0]]
                else:
                    logits = self.model(pixel_values=images).logits

                # Resize logits to tile size then argmax
                logits = F.interpolate(logits, size=(TILE_SIZE, TILE_SIZE), mode='bilinear', align_corners=False)
                preds = logits.argmax(dim=1, keepdim=True).float()  # (B, 1, H, W)

            for i in range(preds.shape[0]):
                pred_tile = crop(
                    preds[i].cpu(),
                    top=PADDING,
                    left=PADDING,
                    height=TILE_SIZE - (2 * PADDING),
                    width=TILE_SIZE - (2 * PADDING),
                )

                minx = int(cropped_windows['col_off'][i])
                maxx = minx + int(cropped_windows['width'][i])
                miny = int(cropped_windows['row_off'][i])
                maxy = miny + int(cropped_windows['width'][i])

                diff_minx = max(0, -minx); minx = max(0, minx)
                diff_miny = max(0, -miny); miny = max(0, miny)
                diff_maxx = max(0, maxx - class_map.shape[1]); maxx = min(maxx, class_map.shape[1])
                diff_maxy = max(0, maxy - class_map.shape[0]); maxy = min(maxy, class_map.shape[0])

                pred_tile = pred_tile[
                    :,
                    diff_miny: pred_tile.shape[1] - diff_maxy if diff_maxy else pred_tile.shape[1],
                    diff_minx: pred_tile.shape[2] - diff_maxx if diff_maxx else pred_tile.shape[2],
                ]
                class_map[miny:maxy, minx:maxx] = pred_tile[0].numpy().astype(np.int8)

        # Apply nodata mask
        try:
            nodata_mask = vrt_src.dataset_mask()
            if set(np.unique(nodata_mask)).issubset({0, 255}):
                valid = (nodata_mask / 255).astype(np.uint8)
                class_map = (class_map * valid).astype(np.int8)
        except Exception:
            pass

        # Extract binary masks per class
        deadwood_mask = (class_map == CLASS_DEADWOOD).astype(np.uint8)
        treecover_mask = (class_map == CLASS_TREECOVER).astype(np.uint8)

        src_crs = vrt_src.crs
        vrt_src.close()

        with rasterio.open(input_tif) as src:
            orig_crs = src.crs

        deadwood_polygons = self._mask_to_filtered_polygons(
            deadwood_mask, dataset.image_src, src_crs, orig_crs
        )
        treecover_polygons = self._mask_to_filtered_polygons(
            treecover_mask, dataset.image_src, src_crs, orig_crs
        )

        return deadwood_polygons, treecover_polygons

    def _mask_to_filtered_polygons(self, mask, image_src, inference_crs, orig_crs):
        polygons = mask_to_polygons(mask, image_src)
        polygons = filter_polygons_by_area(polygons, MINIMUM_POLYGON_AREA)
        polygons = reproject_polygons(polygons, inference_crs, orig_crs)
        return polygons
