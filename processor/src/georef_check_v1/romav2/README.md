# RoMa v2 (vendored)

Dense image matcher used by the georeferencing check (`georef_check_v1`).
Source: https://github.com/Parskatt/RoMaV2 at commit `95c9968` (v2.0.1), MIT
license (see `LICENSE`). Only the inference modules are copied; benchmarks,
visualisation and the package logger setup are left out.

Vendored rather than installed because the package metadata requires
torchvision >= 0.23 while the processor pins torch 2.6 / torchvision 0.21 for
its other models; the inference code itself runs on both.

Changes from upstream:

- package-relative imports (`from .x import ...`);
- `RoMaV2(cfg, weights_path)` loads the checkpoint from a local safetensors
  file instead of downloading the pickled upstream file;
- `Descriptor.Cfg.repo_dir` loads the DINOv3 backbone code from a local copy of
  the `facebookresearch/dinov3` hub repository (commit `adc2544`, DINOv3
  License) with `pretrained=False`; its weights are part of the RoMa v2
  checkpoint;
- the VGG19 refiner features are built with `weights=None` for the same reason.

Both the checkpoint and the DINOv3 repository copy ship as the
`models/georef_check_v1` processor asset (`scripts/package_georef_check_model.py`).
