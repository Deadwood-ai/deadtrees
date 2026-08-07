from __future__ import annotations


DEADWOOD_V1_MODEL_CHECKPOINT_NAME = 'segformer_b5_full_epoch_100.safetensors'
COMBINED_MODEL_CHECKPOINT_NAME = 'ckpt_weighted_brownweight15_goldentestweight7.safetensors'
AOI_V1_MODEL_CHECKPOINT_NAME = 'b1_50epoch_best_macro_f1.safetensors'

GADM_ASSET_PATH = 'gadm/gadm_410.gpkg'
BIOME_ASSET_PATH = 'biom/terres_ecosystems.gpkg'
PHENOLOGY_ASSET_PATH = 'pheno/modispheno_aggregated_normalized_filled.zarr'
PHENOLOGY_ARRAY_NAMES = ('day', 'nan_mask', 'phenology', 'x', 'y')


def processor_model_checkpoint_specs() -> dict[str, tuple[int, tuple[str, ...]]]:
	return {
		DEADWOOD_V1_MODEL_CHECKPOINT_NAME: (1000, ('_orig_mod.decoder.blocks.0.conv1.1.num_batches_tracked',)),
		COMBINED_MODEL_CHECKPOINT_NAME: (600, ('model.decode_head.batch_norm.bias',)),
		AOI_V1_MODEL_CHECKPOINT_NAME: (200, ('model.decode_head.batch_norm.bias',)),
	}


def required_processor_asset_files() -> tuple[str, ...]:
	return (
		*(f'models/{name}' for name in processor_model_checkpoint_specs()),
		GADM_ASSET_PATH,
		BIOME_ASSET_PATH,
		f'{PHENOLOGY_ASSET_PATH}/.zgroup',
		f'{PHENOLOGY_ASSET_PATH}/.zmetadata',
		*(f'{PHENOLOGY_ASSET_PATH}/{name}/.zarray' for name in PHENOLOGY_ARRAY_NAMES),
	)


def required_processor_asset_directories() -> tuple[str, ...]:
	return tuple(f'{PHENOLOGY_ASSET_PATH}/{name}' for name in PHENOLOGY_ARRAY_NAMES)
