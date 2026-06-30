import os
import tempfile
from pathlib import Path

import numpy as np
import rasterio
import torch
import torch.nn.functional as F
from rasterio.windows import Window as RioWindow
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
    mask_to_polygons_scanline,
    reproject_polygons,
)

CHECKPOINT_NAME = 'ckpt_weighted_brownweight15_goldentestweight7.safetensors'

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

# Douglas-Peucker simplification tolerance (metres) applied to both the deadwood
# and treecover polygons. Pixel-traced masks at 5cm carry huge runs of redundant
# near-collinear staircase vertices; simplifying at 10cm removes ~6x of them with
# no visible change, keeping the stored geometry (and MVT/exports) light.
SIMPLIFY_TOLERANCE = 0.10  # metres


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

        tmp_class_path = None
        tmp_treecover_path = None
        try:
            # Two temp GeoTIFFs written tile-by-tile during inference so the full
            # class map never lives in RAM. Nodata is applied per tile from the
            # VRT mask band, avoiding a full-res dataset_mask() load entirely.
            with tempfile.NamedTemporaryFile(suffix='_class.tif', delete=False) as f:
                tmp_class_path = f.name
            with tempfile.NamedTemporaryFile(suffix='_treecover.tif', delete=False) as f:
                tmp_treecover_path = f.name

            tif_kwargs = dict(
                driver='GTiff',
                height=dataset.height,
                width=dataset.width,
                count=1,
                dtype=np.uint8,
                crs=vrt_src.crs,
                transform=vrt_src.transform,
            )
            with (
                rasterio.open(tmp_class_path, 'w', **tif_kwargs) as dst_class,
                rasterio.open(tmp_treecover_path, 'w', **tif_kwargs) as dst_treecover,
            ):
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
                        diff_maxx = max(0, maxx - dataset.width); maxx = min(maxx, dataset.width)
                        diff_maxy = max(0, maxy - dataset.height); maxy = min(maxy, dataset.height)

                        if maxx <= minx or maxy <= miny:
                            continue

                        pred_tile = pred_tile[
                            :,
                            diff_miny: pred_tile.shape[1] - diff_maxy if diff_maxy else pred_tile.shape[1],
                            diff_minx: pred_tile.shape[2] - diff_maxx if diff_maxx else pred_tile.shape[2],
                        ]

                        out_window = RioWindow(col_off=minx, row_off=miny, width=maxx - minx, height=maxy - miny)
                        class_arr = pred_tile[0].numpy().astype(np.uint8)

                        nodata_tile = vrt_src.read_masks(1, window=out_window)
                        class_arr[nodata_tile == 0] = CLASS_BACKGROUND

                        dst_class.write(class_arr, 1, window=out_window)
                        dst_treecover.write((class_arr > 0).astype(np.uint8), 1, window=out_window)

            src_crs = vrt_src.crs
            vrt_src.close()

            with rasterio.open(input_tif) as src:
                orig_crs = src.crs

            # Polygonize directly from the temp files — GDAL reads scanline-by-scanline
            # so no full-res array is materialised. Deadwood is a subset of treecover;
            # the treecover file stores 1 wherever class != background so they merge
            # naturally without a union step.
            with rasterio.open(tmp_class_path) as ds:
                deadwood_polys = mask_to_polygons_scanline(ds, CLASS_DEADWOOD)

            deadwood_polygons = self._filter_polygons(deadwood_polys, src_crs, orig_crs)

            with rasterio.open(tmp_treecover_path) as ds:
                treecover_polys = mask_to_polygons_scanline(ds, 1)

            treecover_polygons = self._filter_polygons(treecover_polys, src_crs, orig_crs)

            return deadwood_polygons, treecover_polygons

        finally:
            for p in (tmp_class_path, tmp_treecover_path):
                if p and os.path.exists(p):
                    os.unlink(p)

    def _filter_polygons(self, polygons, inference_crs, orig_crs):
        polygons = filter_polygons_by_area(polygons, MINIMUM_POLYGON_AREA)
        # Simplify while still in the metric inference CRS so the tolerance is in metres.
        # Keep the original polygon on the rare chance simplify collapses it, so the
        # feature count stays stable and no label is silently dropped.
        simplified = []
        for polygon in polygons:
            simple = polygon.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            simplified.append(polygon if simple.is_empty else simple)
        print(f'Simplified {len(polygons)} polygons at {SIMPLIFY_TOLERANCE}m tolerance.')
        polygons = reproject_polygons(simplified, inference_crs, orig_crs)
        return polygons
