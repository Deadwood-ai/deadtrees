from __future__ import annotations


DEADWOOD_V1_MODEL_CHECKPOINT_NAME = 'segformer_b5_full_epoch_100.safetensors'
COMBINED_MODEL_CHECKPOINT_NAME = 'ckpt_weighted_brownweight15_goldentestweight7.safetensors'
AOI_V1_MODEL_CHECKPOINT_NAME = 'b1_50epoch_best_macro_f1.safetensors'

GADM_ASSET_PATH = 'gadm/gadm_410.gpkg'
BIOME_ASSET_PATH = 'biom/terres_ecosystems.gpkg'
PHENOLOGY_ASSET_PATH = 'pheno/modispheno_aggregated_normalized_filled.zarr'
GEOPACKAGE_SPECS = {
	GADM_ASSET_PATH: ('gadm_410', ('geom', 'GID_0', 'NAME_0', 'CONTINENT')),
	BIOME_ASSET_PATH: ('terres_ecosystems', ('geom', 'ECO_NAME', 'REALM', 'BIOME')),
}
PHENOLOGY_ARRAY_SPECS = {
	'day': ((366,), (366,), ()),
	'nan_mask': ((1680, 4320), (420, 1080), ()),
	'phenology': (
		(1680, 4320, 366),
		(105, 540, 46),
		(
			'14.3.0', '14.3.1', '14.6.0', '14.6.1', '14.6.2', '14.6.7',
			'15.1.0', '15.1.1', '15.1.2', '15.1.7', '15.2.0', '15.2.1',
			'15.2.2', '15.2.7', '15.3.0', '15.3.1', '15.3.2', '15.3.7',
			'15.4.0', '15.4.1', '15.4.2', '15.4.7', '15.5.0', '15.5.1',
			'15.5.2', '15.5.6', '15.5.7', '15.6.0', '15.6.1', '15.6.2',
			'15.6.7',
		),
	),
	'x': ((4320,), (4320,), ()),
	'y': ((1680,), (1680,), ()),
}


def processor_model_checkpoint_specs() -> dict[str, tuple[int, tuple[str, ...]]]:
	return {
		DEADWOOD_V1_MODEL_CHECKPOINT_NAME: (1000, ('_orig_mod.decoder.blocks.0.conv1.1.num_batches_tracked',)),
		COMBINED_MODEL_CHECKPOINT_NAME: (600, ('model.decode_head.batch_norm.bias',)),
		AOI_V1_MODEL_CHECKPOINT_NAME: (200, ('model.decode_head.batch_norm.bias',)),
	}


def required_processor_asset_files() -> tuple[str, ...]:
	return (
		*(f'models/{name}' for name in processor_model_checkpoint_specs()),
		*GEOPACKAGE_SPECS,
		f'{PHENOLOGY_ASSET_PATH}/.zgroup',
		f'{PHENOLOGY_ASSET_PATH}/.zmetadata',
		*(f'{PHENOLOGY_ASSET_PATH}/{name}/.zarray' for name in PHENOLOGY_ARRAY_SPECS),
	)


def required_processor_asset_directories() -> tuple[str, ...]:
	return tuple(f'{PHENOLOGY_ASSET_PATH}/{name}' for name in PHENOLOGY_ARRAY_SPECS)
