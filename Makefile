# Variables
ASSETS_DIR := assets
TEST_DATA_DIR := $(ASSETS_DIR)/test_data
TEST_RAW_DRONE_IMAGES_DIR := $(TEST_DATA_DIR)/raw_drone_images
DTE_TEST_DIR := data/assets/dte_maps
MODELS_DIR := $(ASSETS_DIR)/models
GADM_DIR := $(ASSETS_DIR)/gadm

# URLs for assets
TEST_DATA_BASE_URL := https://data2.deadtrees.earth/assets/v1/test_data
TEST_DATA_URL := $(TEST_DATA_BASE_URL)/test-data.tif
TEST_DATA_SMALL_URL := $(TEST_DATA_BASE_URL)/test-data-small.tif
TEST_DATA_REAL_LABELS_URL := $(TEST_DATA_BASE_URL)/yanspain_crop_124_polygons.gpkg
TEST_RAW_DRONE_ZIP_URL := $(TEST_DATA_BASE_URL)/raw_drone_images/test_no_rtk_3_images.zip
TEST_ODM_MINIMAL_ZIP_URL := $(TEST_DATA_BASE_URL)/raw_drone_images/test_minimal_5_images.zip
MODEL_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets//segformer_b5_full_epoch_100.safetensors
GADM_URL := https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip

# Target files
TEST_DATA := $(TEST_DATA_DIR)/test-data.tif
TEST_DATA_SMALL := $(TEST_DATA_DIR)/test-data-small.tif
TEST_DATA_REAL_LABELS := $(TEST_DATA_DIR)/yanspain_crop_124_polygons.gpkg
TEST_RAW_DRONE_ZIP := $(TEST_RAW_DRONE_IMAGES_DIR)/test_no_rtk_3_images.zip
TEST_ODM_MINIMAL_ZIP := $(TEST_RAW_DRONE_IMAGES_DIR)/test_minimal_5_images.zip
MODEL := $(MODELS_DIR)/segformer_b5_full_epoch_100.safetensors
GADM := $(GADM_DIR)/gadm_410.gpkg
GADM_ZIP := $(GADM_DIR)/gadm_410-gpkg.zip
DTE_TEST_FILENAMES := \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2020.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2022.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_2025.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2020.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2022.cog.tif \
	run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_2025.cog.tif
DTE_TEST_FILES := $(addprefix $(DTE_TEST_DIR)/,$(DTE_TEST_FILENAMES))

.PHONY: all clean setup-dirs create-dirs symlinks

all: setup-dirs download-assets

setup-dirs:
	mkdir -p $(TEST_DATA_DIR)
	mkdir -p $(TEST_RAW_DRONE_IMAGES_DIR)
	mkdir -p $(DTE_TEST_DIR)
	mkdir -p $(MODELS_DIR)
	mkdir -p $(GADM_DIR)

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

$(TEST_DATA) $(TEST_DATA_SMALL) $(TEST_DATA_REAL_LABELS) $(TEST_RAW_DRONE_ZIP) $(TEST_ODM_MINIMAL_ZIP) $(MODEL) $(GADM_ZIP) $(DTE_TEST_FILES): | setup-dirs

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

$(DTE_TEST_DIR)/%.tif:
	@echo "Downloading DTE test clip $(@F)..."
	curl -L -o $@ "$(TEST_DATA_BASE_URL)/dte_maps/$(@F)"

$(GADM): $(GADM_ZIP)
	@if [ ! -f $@ ]; then \
		echo "Extracting GADM data..." && \
		unzip -j $< -d $(GADM_DIR) && \
		rm $<; \
	else \
		echo "GADM data already exists at $(GADM), skipping extraction"; \
	fi

$(GADM_ZIP):
	@if [ ! -f $(GADM) ]; then \
		echo "Downloading GADM data..." && \
		curl -L -o $@ "$(GADM_URL)"; \
	else \
		echo "GADM data already exists, skipping download"; \
		touch $@; \
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
