# Variables
ASSETS_DIR := assets
TEST_DATA_DIR := $(ASSETS_DIR)/test_data
TEST_RAW_DRONE_IMAGES_DIR := $(TEST_DATA_DIR)/raw_drone_images
DTE_TEST_DIR := data/assets/dte_maps
MODELS_DIR := $(ASSETS_DIR)/models
GADM_DIR := $(ASSETS_DIR)/gadm
BIOME_DIR := $(ASSETS_DIR)/biom
PHENO_DIR := $(ASSETS_DIR)/pheno
LOCAL_TEST_SSH_DIR := .local/ssh
LOCAL_TEST_SSH_KEY := $(LOCAL_TEST_SSH_DIR)/processing-to-storage
LOCAL_TEST_SSH_PUB_KEY := $(LOCAL_TEST_SSH_KEY).pub

# URLs for assets
ASSETS_BASE_URL := https://data2.deadtrees.earth/assets/v1
TEST_DATA_BASE_URL := https://data2.deadtrees.earth/assets/v1/test_data
TEST_DATA_URL := $(TEST_DATA_BASE_URL)/test-data.tif
TEST_DATA_SMALL_URL := $(TEST_DATA_BASE_URL)/test-data-small.tif
TEST_DATA_REAL_LABELS_URL := $(TEST_DATA_BASE_URL)/yanspain_crop_124_polygons.gpkg
TEST_RAW_DRONE_ZIP_URL := $(TEST_DATA_BASE_URL)/raw_drone_images/test_no_rtk_3_images.zip
TEST_ODM_MINIMAL_ZIP_URL := $(TEST_DATA_BASE_URL)/raw_drone_images/test_minimal_5_images.zip
WORLDVIEW_FIXTURE_URL := $(TEST_DATA_BASE_URL)/worldview_uint16_crop.tif
MODEL_URL := $(ASSETS_BASE_URL)/models/segformer_b5_full_epoch_100.safetensors
GADM_URL := $(ASSETS_BASE_URL)/gadm/gadm_410.gpkg
BIOME_URL := $(ASSETS_BASE_URL)/biom/terres_ecosystems.gpkg
PHENOLOGY_ARCHIVE_URL := $(ASSETS_BASE_URL)/pheno/modispheno_aggregated_normalized_filled.zarr.tar.gz

# Target files
TEST_DATA := $(TEST_DATA_DIR)/test-data.tif
TEST_DATA_SMALL := $(TEST_DATA_DIR)/test-data-small.tif
TEST_DATA_REAL_LABELS := $(TEST_DATA_DIR)/yanspain_crop_124_polygons.gpkg
TEST_RAW_DRONE_ZIP := $(TEST_RAW_DRONE_IMAGES_DIR)/test_no_rtk_3_images.zip
TEST_ODM_MINIMAL_ZIP := $(TEST_RAW_DRONE_IMAGES_DIR)/test_minimal_5_images.zip
WORLDVIEW_FIXTURE := $(TEST_DATA_DIR)/worldview_uint16_crop.tif
MODEL := $(MODELS_DIR)/segformer_b5_full_epoch_100.safetensors
GADM := $(GADM_DIR)/gadm_410.gpkg
BIOME := $(BIOME_DIR)/terres_ecosystems.gpkg
PHENOLOGY_DATA := $(PHENO_DIR)/modispheno_aggregated_normalized_filled.zarr
PHENOLOGY_ARCHIVE := $(PHENO_DIR)/modispheno_aggregated_normalized_filled.zarr.tar.gz
DTE_TEST_FILENAMES := \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2020.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2022.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2025.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2020.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2022.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2025.cog.tif
DTE_TEST_FILES := $(addprefix $(DTE_TEST_DIR)/,$(DTE_TEST_FILENAMES))

.PHONY: all clean setup-dirs create-dirs symlinks setup-local-test-ssh download-processor-assets

all: setup-dirs download-assets

setup-dirs:
	mkdir -p $(TEST_DATA_DIR)
	mkdir -p $(TEST_RAW_DRONE_IMAGES_DIR)
	mkdir -p $(DTE_TEST_DIR)
	mkdir -p $(MODELS_DIR)
	mkdir -p $(GADM_DIR)
	mkdir -p $(BIOME_DIR)
	mkdir -p $(PHENO_DIR)

create-dirs:
	@echo "Creating data directories..."
	@mkdir -p $(ASSETS_DIR)
	@mkdir -p $(TEST_RAW_DRONE_IMAGES_DIR)
	@mkdir -p data/archive
	@mkdir -p data/cogs
	@mkdir -p $(DTE_TEST_DIR)
	@mkdir -p data/thumbnails
	@mkdir -p data/label_objects
	@mkdir -p data/trash

download-assets: create-dirs $(TEST_DATA) $(TEST_DATA_SMALL) $(MODEL) $(GADM) $(TEST_DATA_REAL_LABELS) $(TEST_RAW_DRONE_ZIP) $(TEST_ODM_MINIMAL_ZIP) $(DTE_TEST_FILES)
download-processor-assets: create-dirs $(BIOME) $(PHENOLOGY_DATA) $(WORLDVIEW_FIXTURE)

setup-local-test-ssh:
	@mkdir -p $(LOCAL_TEST_SSH_DIR)
	@if [ ! -f $(LOCAL_TEST_SSH_KEY) ] || [ ! -f $(LOCAL_TEST_SSH_PUB_KEY) ]; then \
		echo "Generating local processor test SSH key..."; \
		ssh-keygen -t ed25519 -N "" -C "deadtrees-local-test" -f $(LOCAL_TEST_SSH_KEY) >/dev/null; \
	else \
		echo "Local processor test SSH key already exists at $(LOCAL_TEST_SSH_KEY)"; \
	fi
	@chmod 600 $(LOCAL_TEST_SSH_KEY)
	@chmod 644 $(LOCAL_TEST_SSH_PUB_KEY)

$(TEST_DATA) $(TEST_DATA_SMALL) $(TEST_DATA_REAL_LABELS) $(TEST_RAW_DRONE_ZIP) $(TEST_ODM_MINIMAL_ZIP) $(WORLDVIEW_FIXTURE) $(MODEL) $(GADM) $(BIOME) $(PHENOLOGY_ARCHIVE) $(DTE_TEST_FILES): | setup-dirs

$(TEST_DATA):
	@echo "Downloading test data..."
	curl -L -o $@ "$(TEST_DATA_URL)"

$(TEST_DATA_SMALL):
	@echo "Downloading small test data..."
	curl -L -o $@ "$(TEST_DATA_SMALL_URL)"

$(MODEL):
	@echo "Downloading model..."
	curl -L -o $@ "$(MODEL_URL)"

$(TEST_DATA_REAL_LABELS):
	@echo "Downloading real labels..."
	curl -L -o $@ "$(TEST_DATA_REAL_LABELS_URL)"

$(TEST_RAW_DRONE_ZIP):
	@echo "Downloading upload ZIP test data..."
	curl -L -o $@ "$(TEST_RAW_DRONE_ZIP_URL)"

$(TEST_ODM_MINIMAL_ZIP):
	@echo "Downloading minimal ODM ZIP test data..."
	curl -L -o $@ "$(TEST_ODM_MINIMAL_ZIP_URL)"

$(WORLDVIEW_FIXTURE):
	@echo "Downloading WorldView scaling fixture..."
	curl -L -o $@ "$(WORLDVIEW_FIXTURE_URL)"

$(DTE_TEST_DIR)/%.tif:
	@echo "Downloading DTE test clip $(@F)..."
	curl -L -o $@ "$(TEST_DATA_BASE_URL)/dte_maps/$(@F)"

$(GADM):
	@if [ ! -f $@ ]; then \
		echo "Downloading GADM data..." && \
		curl -L -o $@ "$(GADM_URL)"; \
	else \
		echo "GADM data already exists at $(GADM), skipping extraction"; \
	fi

$(BIOME):
	@echo "Downloading biome support data..."
	curl -L -o $@ "$(BIOME_URL)"

$(PHENOLOGY_ARCHIVE):
	@echo "Downloading phenology support data..."
	curl -L -o $@ "$(PHENOLOGY_ARCHIVE_URL)"

$(PHENOLOGY_DATA): $(PHENOLOGY_ARCHIVE)
	@if [ ! -d $@ ]; then \
		echo "Extracting phenology support data..." && \
		tar -xzf $< -C $(PHENO_DIR); \
	else \
		echo "Phenology data already exists at $(PHENOLOGY_DATA), skipping extraction"; \
	fi

clean:
	rm -rf $(ASSETS_DIR)/*

# Create symlinks for test data in legacy locations
symlinks: download-assets
	mkdir -p api/tests/test_data
	mkdir -p processor/tests/test_data
	mkdir -p processor/src/deadwood_segmentation/models
	ln -sf $(abspath $(TEST_DATA_SMALL)) api/tests/test_data/
	ln -sf $(abspath $(TEST_DATA_SMALL)) processor/tests/test_data/
	ln -sf $(abspath $(MODEL)) processor/src/deadwood_segmentation/models/
