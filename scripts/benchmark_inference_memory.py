"""Benchmark peak RSS of postprocessing approaches for deadwood_v1 and combined_v2.

Three tiers compared:
  batch   — original: full-res numpy accumulator, simultaneous masks, no del
  inplace — previous commit: in-place nodata, sequential mask del (still full-res)
  stream  — this commit: tile-by-tile temp GeoTIFF, raster never in RAM

RSS subprocesses only measure the raster accumulation phase (where the
difference is). Polygonisation produces vectors (small) and is validated
separately on blocky 512×512 arrays via a lossless roundtrip check.

Usage (from repo root, venv active):
    python scripts/benchmark_inference_memory.py
"""

import os
import resource
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize as rio_rasterize
from rasterio.transform import from_origin
from shapely.geometry import mapping

REPO_ROOT = Path(__file__).resolve().parent.parent
TEST_TIF = REPO_ROOT / "assets/test_data/test-data.tif"

CLASS_BACKGROUND = 0
CLASS_TREECOVER = 1
CLASS_DEADWOOD = 2
THRESHOLD = 0.5


# ---------------------------------------------------------------------------
# Input generation
# ---------------------------------------------------------------------------

def _metric_transform():
    return from_origin(west=500_000.0, north=5_400_000.0, xsize=0.05, ysize=0.05)


def _make_blocky_class_map(h, w, block_size=32, seed=42):
    """Block-uniform class map — realistic patch structure, fast to polygonise."""
    rng = np.random.default_rng(seed)
    bh = (h + block_size - 1) // block_size
    bw = (w + block_size - 1) // block_size
    blocks = rng.integers(0, 3, size=(bh, bw), dtype=np.uint8)
    out = np.repeat(np.repeat(blocks, block_size, axis=0), block_size, axis=1)
    return out[:h, :w]


def _make_blocky_float_map(h, w, block_size=32, seed=99):
    """Block-uniform float map — thresholding gives contiguous binary regions."""
    rng = np.random.default_rng(seed)
    bh = (h + block_size - 1) // block_size
    bw = (w + block_size - 1) // block_size
    blocks = rng.random((bh, bw)).astype(np.float32)
    out = np.repeat(np.repeat(blocks, block_size, axis=0), block_size, axis=1)
    return out[:h, :w]


def _make_nodata(h, w):
    nodata = np.full((h, w), 255, dtype=np.uint8)
    nodata[: max(1, h // 20), :] = 0
    nodata[-max(1, h // 20) :, :] = 0
    return nodata


def _write_tif(path, arr, transform):
    crs = rasterio.crs.CRS.from_epsg(32632)
    h, w = arr.shape
    with rasterio.open(path, 'w', driver='GTiff', height=h, width=w,
                       count=1, dtype=arr.dtype, crs=crs, transform=transform) as dst:
        dst.write(arr, 1)


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _rasterize(polygons, h, w, transform):
    if not polygons:
        return np.zeros((h, w), dtype=np.uint8)
    return rio_rasterize(
        [(mapping(p), 1) for p in polygons],
        out_shape=(h, w),
        transform=transform,
        fill=0,
        dtype=np.uint8,
    )


def _check_roundtrip(label, expected_mask, polygons, h, w, transform):
    recovered = _rasterize(polygons, h, w, transform)
    if not np.array_equal(expected_mask, recovered):
        diff = int(np.count_nonzero(expected_mask != recovered))
        raise AssertionError(
            f"ROUNDTRIP MISMATCH [{label}]: {diff}/{h * w} pixels differ "
            f"({diff / (h * w) * 100:.3f} %)"
        )


# ---------------------------------------------------------------------------
# Streaming postprocess (uses actual shared functions)
# ---------------------------------------------------------------------------

def _stream_postprocess_combined(class_map, nodata_mask):
    from processor.src.utils.segmentation import mask_to_polygons_scanline
    h, w = class_map.shape
    transform = _metric_transform()
    crs = rasterio.crs.CRS.from_epsg(32632)
    tmp_class = tmp_tc = None
    try:
        with tempfile.NamedTemporaryFile(suffix='_class.tif', delete=False) as f:
            tmp_class = f.name
        with tempfile.NamedTemporaryFile(suffix='_tc.tif', delete=False) as f:
            tmp_tc = f.name
        class_arr = class_map.copy()
        class_arr[nodata_mask == 0] = CLASS_BACKGROUND
        _write_tif(tmp_class, class_arr, transform)
        _write_tif(tmp_tc, (class_arr > 0).astype(np.uint8), transform)
        with rasterio.open(tmp_class) as ds:
            d_polys = mask_to_polygons_scanline(ds, CLASS_DEADWOOD)
        with rasterio.open(tmp_tc) as ds:
            t_polys = mask_to_polygons_scanline(ds, 1)
        return d_polys, t_polys
    finally:
        for p in (tmp_class, tmp_tc):
            if p and os.path.exists(p):
                os.unlink(p)


def _stream_postprocess_v1(float_map, nodata_mask):
    from processor.src.utils.segmentation import mask_to_polygons_scanline
    h, w = float_map.shape
    transform = _metric_transform()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='_dw.tif', delete=False) as f:
            tmp_path = f.name
        binary = (float_map > THRESHOLD).astype(np.uint8)
        binary[nodata_mask == 0] = 0
        _write_tif(tmp_path, binary, transform)
        with rasterio.open(tmp_path) as ds:
            return mask_to_polygons_scanline(ds, 1)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Validation: polygonise on 512×512 blocky arrays, check lossless roundtrip
# ---------------------------------------------------------------------------

def validate():
    H, W = 512, 512
    transform = _metric_transform()
    class_map = _make_blocky_class_map(H, W, block_size=32)
    float_map  = _make_blocky_float_map(H, W, block_size=32)
    nodata     = _make_nodata(H, W)

    cases = {
        "standard nodata (0/255 border)": nodata,
        "all valid":                       np.full((H, W), 255, dtype=np.uint8),
    }

    print("=== Validation (512×512, blocky patches) ===")
    for case_label, nd in cases.items():
        # combined_v2
        class_arr = class_map.copy()
        class_arr[nd == 0] = CLASS_BACKGROUND
        expected_dw = (class_arr == CLASS_DEADWOOD).astype(np.uint8)
        expected_tc = (class_arr > 0).astype(np.uint8)

        d_polys, t_polys = _stream_postprocess_combined(class_map.copy(), nd)
        _check_roundtrip(f"combined_v2 deadwood [{case_label}]", expected_dw, d_polys, H, W, transform)
        _check_roundtrip(f"combined_v2 treecover [{case_label}]", expected_tc, t_polys, H, W, transform)

        # deadwood_v1
        binary = (float_map > THRESHOLD).astype(np.uint8)
        binary[nd == 0] = 0
        v1_polys = _stream_postprocess_v1(float_map.copy(), nd)
        _check_roundtrip(f"deadwood_v1 [{case_label}]", binary, v1_polys, H, W, transform)

        print(f"  OK  {case_label}")

    print()


# ---------------------------------------------------------------------------
# RSS subprocess scenarios — raster accumulation phase only
# (polygonize produces vectors; RSS gain is entirely in the raster phase)
# ---------------------------------------------------------------------------

def scenario_batch_combined(h, w):
    """Old path: full-res class_map + simultaneous deadwood + treecover masks."""
    class_map = _make_blocky_class_map(h, w)
    nodata    = _make_nodata(h, w)
    if set(np.unique(nodata)).issubset({0, 255}):
        valid     = (nodata / 255).astype(np.uint8)
        class_map = (class_map * valid).astype(np.uint8)
    deadwood_mask  = (class_map == CLASS_DEADWOOD).astype(np.uint8)
    treecover_mask = ((class_map == CLASS_TREECOVER) | (class_map == CLASS_DEADWOOD)).astype(np.uint8)
    return int(deadwood_mask.sum()) + int(treecover_mask.sum())


def scenario_stream_combined(h, w):
    """New path: write tiles to temp files; only one tile in RAM at a time."""
    class_map = _make_blocky_class_map(h, w)
    nodata    = _make_nodata(h, w)
    transform = _metric_transform()
    crs = rasterio.crs.CRS.from_epsg(32632)
    tmp_class = tmp_tc = None
    try:
        with tempfile.NamedTemporaryFile(suffix='_class.tif', delete=False) as f:
            tmp_class = f.name
        with tempfile.NamedTemporaryFile(suffix='_tc.tif', delete=False) as f:
            tmp_tc = f.name
        tif_kw = dict(driver='GTiff', height=h, width=w, count=1,
                      dtype=np.uint8, crs=crs, transform=transform)
        class_arr = class_map.copy()
        class_arr[nodata == 0] = CLASS_BACKGROUND
        with rasterio.open(tmp_class, 'w', **tif_kw) as dc, \
             rasterio.open(tmp_tc,    'w', **tif_kw) as dt:
            dc.write(class_arr, 1)
            dt.write((class_arr > 0).astype(np.uint8), 1)
        return 0
    finally:
        for p in (tmp_class, tmp_tc):
            if p and os.path.exists(p):
                os.unlink(p)


def scenario_batch_v1(h, w):
    """Old path: float32 accumulator + uint8 mask + nodata copy simultaneously."""
    float_map = _make_blocky_float_map(h, w)
    nodata    = _make_nodata(h, w)
    outimage  = (float_map > THRESHOLD).astype(np.uint8)
    if set(np.unique(nodata)).issubset({0, 255}):
        outimage = outimage * (nodata / 255).astype(np.uint8)
    return int(outimage.sum())


def scenario_stream_v1(h, w):
    """New path: threshold per tile, write uint8 to temp file."""
    float_map = _make_blocky_float_map(h, w)
    nodata    = _make_nodata(h, w)
    transform = _metric_transform()
    crs = rasterio.crs.CRS.from_epsg(32632)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='_dw.tif', delete=False) as f:
            tmp_path = f.name
        binary = (float_map > THRESHOLD).astype(np.uint8)
        binary[nodata == 0] = 0
        with rasterio.open(tmp_path, 'w', driver='GTiff', height=h, width=w,
                           count=1, dtype=np.uint8, crs=crs, transform=transform) as dst:
            dst.write(binary, 1)
        return 0
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


SCENARIOS = {
    "batch_combined":  scenario_batch_combined,
    "stream_combined": scenario_stream_combined,
    "batch_v1":        scenario_batch_v1,
    "stream_v1":       scenario_stream_v1,
}


def _run_scenario(name, h, w):
    SCENARIOS[name](h, w)
    kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KiB on Linux
    print(kb)


# ---------------------------------------------------------------------------
# Parent: spawn subprocesses and collect peak RSS
# ---------------------------------------------------------------------------

def measure(name, h, w):
    result = subprocess.run(
        [sys.executable, __file__, "--scenario", name, str(h), str(w)],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(result.stdout.strip()) / 1024  # KiB → MiB


def main():
    validate()

    with rasterio.open(TEST_TIF) as src:
        h, w = src.height, src.width

    pixel_count = h * w
    print(f"Test image: {w}×{h} px  ({pixel_count / 1e6:.1f} Mpx)")
    print(f"  1× full-res uint8   = {pixel_count / 1024**2:.1f} MiB")
    print(f"  1× full-res float32 = {pixel_count * 4 / 1024**2:.1f} MiB")
    print()

    groups = [
        ("combined_v2  (raster accumulation phase)", "batch_combined",  "stream_combined"),
        ("deadwood_v1  (raster accumulation phase)", "batch_v1",        "stream_v1"),
    ]

    for label, batch_name, stream_name in groups:
        print(f"=== {label} ===")
        batch_mib  = measure(batch_name,  h, w)
        stream_mib = measure(stream_name, h, w)
        saving = batch_mib - stream_mib
        pct = saving / batch_mib * 100 if batch_mib else 0
        print(f"  batch   peak RSS = {batch_mib:7.1f} MiB")
        print(f"  stream  peak RSS = {stream_mib:7.1f} MiB")
        print(f"  saving           = {saving:7.1f} MiB  ({pct:.0f} %)")
        print()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--scenario":
        name, h, w = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
        sys.path.insert(0, str(REPO_ROOT))
        _run_scenario(name, h, w)
    else:
        sys.path.insert(0, str(REPO_ROOT))
        main()
