# Variables
ASSETS_DIR := assets
TEST_DATA_DIR := $(ASSETS_DIR)/test_data
MODELS_DIR := $(ASSETS_DIR)/models
GADM_DIR := $(ASSETS_DIR)/gadm

# URLs for assets
TEST_DATA_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/test-data.tif?t=2025-01-14T08%3A30%3A31.937Z
TEST_DATA_SMALL_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/test-data-small.tif?t=2025-01-14T08%3A30%3A20.146Z
MODEL_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/segformer_b5_fold_0_epoch_74.safetensors?t=2025-01-14T08%3A30%3A40.378Z
GADM_URL := https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip

# Target files
TEST_DATA := $(TEST_DATA_DIR)/test-data.tif
TEST_DATA_SMALL := $(TEST_DATA_DIR)/test-data-small.tif
MODEL := $(MODELS_DIR)/segformer_b5_fold_0_epoch_74.safetensors
GADM := $(GADM_DIR)/gadm_410.gpkg
GADM_ZIP := $(GADM_DIR)/gadm_410-gpkg.zip

.PHONY: all clean setup-dirs download-assets

all: setup-dirs download-assets

setup-dirs:
	mkdir -p $(TEST_DATA_DIR)
	mkdir -p $(MODELS_DIR)
	mkdir -p $(GADM_DIR)

download-assets: $(TEST_DATA) $(TEST_DATA_SMALL) $(MODEL) $(GADM)

$(TEST_DATA):
	curl -L -o $@ "$(TEST_DATA_URL)"

$(TEST_DATA_SMALL):
	curl -L -o $@ "$(TEST_DATA_SMALL_URL)"

$(MODEL):
	curl -L -o $@ "$(MODEL_URL)"

$(GADM): $(GADM_ZIP)
	unzip -j $< -d $(GADM_DIR)
	rm $<

$(GADM_ZIP):
	curl -L -o $@ "$(GADM_URL)"

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