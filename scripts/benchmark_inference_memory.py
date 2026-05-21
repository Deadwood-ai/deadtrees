"""Benchmark peak RSS of old vs new postprocessing for deadwood_v1 and
combined_v2 inference.

The inference loop (GPU forward pass) is unchanged; only postprocessing
differs.  Each scenario runs in its own subprocess so peak RSS is clean.
Validation runs inline on small arrays before the benchmark.

Usage (from repo root, venv active):
    python scripts/benchmark_inference_memory.py
"""

import resource
import subprocess
import sys
from pathlib import Path

import numpy as np
import rasterio

REPO_ROOT = Path(__file__).resolve().parent.parent
TEST_TIF = REPO_ROOT / "assets/test_data/test-data.tif"

CLASS_BACKGROUND = 0
CLASS_TREECOVER = 1
CLASS_DEADWOOD = 2


# ---------------------------------------------------------------------------
# Shared input generation
# ---------------------------------------------------------------------------

def _make_inputs(h, w, seed=42):
    rng = np.random.default_rng(seed)
    class_map = rng.integers(0, 3, size=(h, w), dtype=np.int8)
    float_map = rng.random((h, w)).astype(np.float32)
    # Realistic nodata: 0/255 only, ~5 % nodata border
    nodata = np.full((h, w), 255, dtype=np.uint8)
    nodata[: max(1, h // 20), :] = 0
    nodata[-max(1, h // 20) :, :] = 0
    return class_map, float_map, nodata


# ---------------------------------------------------------------------------
# combined_v2 — old and new, returning arrays for comparison
# ---------------------------------------------------------------------------

def _combined_old(class_map, nodata_mask):
    class_map = class_map.copy()
    if set(np.unique(nodata_mask)).issubset({0, 255}):
        valid = (nodata_mask / 255).astype(np.uint8)
        class_map = (class_map * valid).astype(np.int8)
    deadwood_mask = (class_map == CLASS_DEADWOOD).astype(np.uint8)
    treecover_mask = ((class_map == CLASS_TREECOVER) | (class_map == CLASS_DEADWOOD)).astype(np.uint8)
    return deadwood_mask, treecover_mask


def _combined_new(class_map, nodata_mask):
    class_map = class_map.copy()
    nodata_mask = nodata_mask.copy()
    if set(np.unique(nodata_mask)).issubset({0, 255}):
        class_map[nodata_mask == 0] = 0
    del nodata_mask

    deadwood_mask = (class_map == CLASS_DEADWOOD).astype(np.uint8)
    treecover_mask = ((class_map == CLASS_TREECOVER) | (class_map == CLASS_DEADWOOD)).astype(np.uint8)
    return deadwood_mask, treecover_mask


# ---------------------------------------------------------------------------
# deadwood_v1 — old and new, returning arrays for comparison
# ---------------------------------------------------------------------------

def _v1_old(float_map, nodata_mask, threshold=0.5):
    outimage = (float_map > threshold).astype(np.uint8)
    unique = np.unique(nodata_mask)
    if len(unique) <= 2 and (0 in unique or 255 in unique):
        outimage = outimage * (nodata_mask / 255).astype(np.uint8)
    return outimage


def _v1_new(float_map, nodata_mask, threshold=0.5):
    outimage = (float_map > threshold).astype(np.uint8)
    nodata_mask = nodata_mask.copy()
    unique = np.unique(nodata_mask)
    if len(unique) <= 2 and (0 in unique or 255 in unique):
        outimage[nodata_mask == 0] = 0
    del nodata_mask
    return outimage


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _check(label, a, b):
    if not np.array_equal(a, b):
        diff = np.count_nonzero(a != b)
        raise AssertionError(
            f"MISMATCH [{label}]: {diff} pixel(s) differ "
            f"(old unique={np.unique(a)}, new unique={np.unique(b)})"
        )


def validate():
    """Run both implementations on small arrays and assert identical output."""
    H, W = 256, 256
    class_map, float_map, nodata = _make_inputs(H, W)

    cases = {
        "standard nodata (0/255 border)": nodata,
        "all valid (nodata=255 everywhere)": np.full((H, W), 255, dtype=np.uint8),
        "non-standard nodata (mixed values)": np.arange(H * W, dtype=np.uint16).reshape(H, W).astype(np.uint8),
    }

    print("=== Validation ===")
    for case_label, nd in cases.items():
        d_old, t_old = _combined_old(class_map, nd)
        d_new, t_new = _combined_new(class_map, nd)
        _check(f"combined_v2 deadwood [{case_label}]", d_old, d_new)
        _check(f"combined_v2 treecover [{case_label}]", t_old, t_new)

        v_old = _v1_old(float_map, nd)
        v_new = _v1_new(float_map, nd)
        _check(f"deadwood_v1 [{case_label}]", v_old, v_new)

        print(f"  OK  {case_label}")

    print()


# ---------------------------------------------------------------------------
# Scenario implementations  (run inside subprocesses for RSS measurement)
# ---------------------------------------------------------------------------

def scenario_combined_old(h, w):
    class_map, _, nodata_mask = _make_inputs(h, w)
    d, t = _combined_old(class_map, nodata_mask)
    return d.sum(), t.sum()  # prevent DCE


def scenario_combined_new(h, w):
    class_map, _, nodata_mask = _make_inputs(h, w)
    d, t = _combined_new(class_map, nodata_mask)
    return d.sum(), t.sum()


def scenario_v1_old(h, w):
    _, float_map, nodata_mask = _make_inputs(h, w)
    out = _v1_old(float_map, nodata_mask)
    return out.sum()


def scenario_v1_new(h, w):
    _, float_map, nodata_mask = _make_inputs(h, w)
    out = _v1_new(float_map, nodata_mask)
    return out.sum()


# ---------------------------------------------------------------------------
# Subprocess entry point
# ---------------------------------------------------------------------------

SCENARIOS = {
    "combined_old": scenario_combined_old,
    "combined_new": scenario_combined_new,
    "v1_old": scenario_v1_old,
    "v1_new": scenario_v1_new,
}


def _run_scenario(name, h, w):
    fn = SCENARIOS[name]
    fn(h, w)
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
    kb = int(result.stdout.strip())
    return kb / 1024  # → MiB


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
        ("combined_v2", "combined_old", "combined_new"),
        ("deadwood_v1", "v1_old", "v1_new"),
    ]

    for label, old_name, new_name in groups:
        print(f"=== {label} ===")
        old_mib = measure(old_name, h, w)
        new_mib = measure(new_name, h, w)
        saving = old_mib - new_mib
        pct = saving / old_mib * 100 if old_mib else 0
        print(f"  old  peak RSS = {old_mib:7.1f} MiB")
        print(f"  new  peak RSS = {new_mib:7.1f} MiB")
        print(f"  saving        = {saving:7.1f} MiB  ({pct:.0f} %)")
        print()


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--scenario":
        name = sys.argv[2]
        h, w = int(sys.argv[3]), int(sys.argv[4])
        sys.path.insert(0, str(REPO_ROOT))
        _run_scenario(name, h, w)
    else:
        sys.path.insert(0, str(REPO_ROOT))
        main()
