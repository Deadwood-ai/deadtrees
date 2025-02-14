# Variables
ASSETS_DIR := assets
TEST_DATA_DIR := $(ASSETS_DIR)/test_data
MODELS_DIR := $(ASSETS_DIR)/models
GADM_DIR := $(ASSETS_DIR)/gadm

# URLs for assets
TEST_DATA_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/test-data.tif?t=2025-01-14T08%3A30%3A31.937Z
TEST_DATA_SMALL_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/test-data-small.tif?t=2025-01-14T08%3A30%3A20.146Z
TEST_DATA_REAL_LABELS_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets/yanspain_crop_124_polygons.gpkg?t=2025-01-24T13%3A19%3A53.744Z
MODEL_URL := https://ijuphmnaebfdzsfrnsrn.supabase.co/storage/v1/object/public/assets//segformer_b5_full_epoch_100.safetensors
GADM_URL := https://geodata.ucdavis.edu/gadm/gadm4.1/gadm_410-gpkg.zip

# Target files
TEST_DATA := $(TEST_DATA_DIR)/test-data.tif
TEST_DATA_SMALL := $(TEST_DATA_DIR)/test-data-small.tif
TEST_DATA_REAL_LABELS := $(TEST_DATA_DIR)/yanspain_crop_124_polygons.gpkg
MODEL := $(MODELS_DIR)/segformer_b5_full_epoch_100.safetensors
GADM := $(GADM_DIR)/gadm_410.gpkg
GADM_ZIP := $(GADM_DIR)/gadm_410-gpkg.zip

.PHONY: all clean setup-dirs create-dirs symlinks

all: setup-dirs download-assets

setup-dirs:
	mkdir -p $(TEST_DATA_DIR)
	mkdir -p $(MODELS_DIR)
	mkdir -p $(GADM_DIR)

create-dirs:
	@echo "Creating data directories..."
	@mkdir -p $(ASSETS_DIR)
	@mkdir -p data/archive
	@mkdir -p data/cogs
	@mkdir -p data/thumbnails
	@mkdir -p data/label_objects
	@mkdir -p data/trash

download-assets: create-dirs $(TEST_DATA) $(TEST_DATA_SMALL) $(MODEL) $(GADM) $(TEST_DATA_REAL_LABELS)

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