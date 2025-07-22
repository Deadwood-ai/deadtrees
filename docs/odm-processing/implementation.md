# ODM Raw Drone Image Processing - Implementation Plan

**Version:** 1.0  
**Date:** December 2024  
**Status:** Ready for Implementation

---

## 📋 **IMPLEMENTATION OVERVIEW**

This document outlines the step-by-step implementation plan for integrating OpenDroneMap (ODM) processing into the DeadTrees platform. The implementation follows a **test-driven, atomic approach** where each feature is immediately tested with real data before proceeding.

**Key Implementation Principles:**
- **Test-Driven Development**: Each feature is tested immediately after implementation
- **Real Data Testing**: Use actual drone images and coordinates, not mocks
- **Atomic Changes**: One feature + test per task, fully validated before continuing
- **Incremental Deployment**: Build on existing systems without breaking changes

---

## **Notes**

---

## Rules & Tips

- The `shared/models.py` file uses tab indentation (not spaces) - maintain consistency when adding new enum values or model fields
- EXIF Extraction Strategy: Requirements specify frontend EXIF extraction for immediate UX, but implementation tasks focus on backend extraction - clarify if both approaches are needed or if backend-only is sufficient
- RTK ODM Parameters: When RTK data is detected, ODM must use `--force-gps` flag and `--gps-accuracy` set to centimeter values (0.01-0.05) based on detected RTK precision
- Storage Paths: Use exact path structure - raw images at `raw_images/{dataset_id}/images/` and generated ortho at `raw_images/{dataset_id}/odm_orthophoto.tif`
- RTK File Extensions: Detect all RTK file types including `.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU` extensions
- Database RLS Policies: New v2 tables must have RLS policies created separately - standard pattern requires "Enable insert for authenticated users only", "Enable read access for all users", and "Enable update for processor" policies
- ODM Test Data Creation: The `./scripts/create_odm_test_data.sh` script requires `zip` command - install with `sudo apt install -y zip` if missing
- Import Requirements: Future tasks must import `UploadType` and `detect_upload_type()` from `api/src/utils/file_utils.py` (not from routers) to avoid circular dependencies

---

## 🛠️ **TEST DATA SETUP (Required First)**

### **Task 0.1: Create ODM Test Data**
**Context:** Need real drone image test files for testing throughout implementation.

**Subtasks:**
- [x] **RUN** test data creation script to generate ZIP files
  - Execute: `./scripts/create_odm_test_data.sh`
  - Verify creation of test ZIP files in `assets/test_data/raw_drone_images/`
  - Required files: `test_minimal_3_images.zip` (~30MB), `test_small_10_images.zip` (~100MB)
  - **Test Immediately**: `ls -la assets/test_data/raw_drone_images/test_*.zip`

---

## 🗂️ **PHASE 1: DATABASE & MODEL FOUNDATION**

### **Task 1.1: Database Schema Implementation**

**Context:** The system uses v2_ prefixed tables with Supabase PostgreSQL. Current task types: `cog`, `thumbnail`, `deadwood`, `geotiff`, `metadata`.

**Subtasks:**
- [x] Create sql commands to create the tables, so that i can run them in the supabase editor. 
  - Create new v2_raw_images table following established v2_* patterns
  - Include proper indexing and foreign key constraints
  - Reference existing migration patterns in `supabase/migrations/`

- [x] Create `supabase/migrations/YYYYMMDDHHMMSS_add_odm_status_tracking.sql`
  - Add `odm_processing` to v2_status enum type
  - Add `is_odm_done` boolean flag to v2_statuses table
  - Follow pattern from existing status migrations (20250123150750_adding_new_metadata_status.sql)

### **Task 1.2: Shared Models Extension**

**Context:** Models in `shared/models.py` use Pydantic with enum validation. Current TaskTypeEnum has 5 values: cog, thumbnail, deadwood, geotiff, metadata.

**Subtasks:**
- [x] **ADD** `odm_processing` to `TaskTypeEnum` in `shared/models.py`
  - Add `odm_processing = 'odm_processing'`
  - Maintain alphabetical order for consistency
  - **NOTE**: `geotiff` task type already exists and will be used for ODM output standardization

- [x] **ADD** `odm_processing` to `StatusEnum` in `shared/models.py`  
  - Add `odm_processing = 'odm_processing'`
  - Follow existing status naming patterns

- [x] **ADD** `RawImages` Pydantic model in `shared/models.py`
  - Create new RawImages model for separate v2_raw_images table
  - Include proper field validation and serializers
  - Follow existing model patterns from other v2_* models

- [x] **EXTEND** `Status` Pydantic model in `shared/models.py`
  - Add `is_odm_done: bool = False` field
  - Follow existing boolean flag pattern (is_cog_done, is_thumbnail_done, etc.)

### **Task 1.3: Test Phase 1 Database & Models** 
**Context:** Validate database schema and models work correctly before building on them.

**Subtasks:**
- [x] **CREATE** `shared/tests/db/test_odm_models.py`
  - Test RawImages model validation and serialization
  - Test TaskTypeEnum and StatusEnum include new values
  - Test Status model includes is_odm_done field
     - **Run Test**: `deadtrees dev test api shared/db/tests/test_odm_models.py`

- [x] **CREATE** `api/tests/db/test_odm_database.py` 
  - Test v2_raw_images table creation and constraints
  - Test enum extensions (odm_processing in both enums)
  - Test foreign key relationships work correctly
  - **Run Test**: `deadtrees dev test api api/tests/db/test_odm_database.py`

- [x] **VERIFY** Phase 1 Complete
  - All models tests pass: `deadtrees dev test api shared/db/tests/test_odm_models.py`
  - All database tests pass: `deadtrees dev test api api/db/tests/test_odm_database.py`
  - **STOP** - Do not proceed until Phase 1 tests are passing

---

## 🚀 **PHASE 2: UPLOAD SYSTEM ENHANCEMENT**

### **Task 2.1: Enhanced Upload Endpoint**

**Context:** Current endpoint at `api/src/routers/upload.py` handles chunked GeoTIFF uploads. Need to add smart file type detection and routing.

**Subtasks:**
- [x] **CREATE** `UploadType` enum in `api/src/routers/upload.py`
  - Values: `GEOTIFF = 'geotiff'`, `RAW_IMAGES_ZIP = 'raw_images_zip'`

- [ ] **ADD** `detect_upload_type()` function in upload router
  - Check file extensions (.tif, .tiff, .zip)
  - Return appropriate UploadType enum
  - Handle unsupported file types with HTTPException

- [ ] **ENHANCE** `/datasets/chunk` endpoint with optional upload_type parameter
  - Add `upload_type: Annotated[Optional[UploadType], Form()] = None`
  - Maintain backward compatibility (auto-detect if not provided)
  - Route to appropriate processing logic based on detected type

### **Task 2.2: Test Upload Endpoint Enhancement**
**Context:** Test the enhanced upload endpoint with real ZIP files before building ZIP processing.

**Subtasks:**
- [ ] **CREATE** `api/tests/routers/test_upload_odm_detection.py`
  - Test `detect_upload_type()` with .tif and .zip files
  - Test enhanced chunk endpoint accepts upload_type parameter
  - Test backward compatibility (existing GeoTIFF uploads unchanged)
  - **Run Test**: `deadtrees dev test api api/tests/routers/test_upload_odm_detection.py`

### **Task 2.3: ZIP Processing Implementation**

**Context:** Create ZIP extraction, validation, and transfer logic. Store raw images and create database entries.

**Subtasks:**
- [ ] **CREATE** `api/src/upload/raw_images_processor.py`
  - Function: `async def process_raw_images_upload(...) -> Dataset`
  - Handle ZIP extraction, validation, SSH transfer
  - Create v2_datasets and v2_raw_images entries
  - **NO task queueing** - only file handling and database creation

- [ ] **CREATE** `api/src/upload/exif_utils.py`
  - Function: `extract_comprehensive_exif(image_path: Path) -> Dict[str, Any]`
  - Function: `extract_acquisition_date(image_path: Path) -> Optional[datetime]`
  - Use PIL for EXIF extraction, handle missing data gracefully
  - **NOTE**: Requirements suggest frontend EXIF extraction for immediate UX, but this implements backend extraction - clarify if both approaches are needed

- [ ] **CREATE** `api/src/upload/rtk_utils.py`
  - Function: `detect_rtk_files(zip_files: List[str]) -> Dict[str, Any]`
  - Function: `parse_rtk_timestamp_file(mrk_path: Path) -> Dict[str, Any]`
  - Detect and parse RTK positioning files (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
  - Extract RTK precision values and quality indicators from .MRK files
  - Store files to exact path: `raw_images/{dataset_id}/images/` alongside images

### **Task 2.4: Test ZIP Processing**
**Context:** Test ZIP processing with real drone image files and verify all functionality.

**Subtasks:**
- [ ] **CREATE** `api/tests/routers/test_upload_odm_zip.py`
  - Test ZIP upload creates v2_datasets and v2_raw_images entries
  - Test EXIF extraction populates acquisition date correctly
  - Test RTK detection identifies RTK files and metadata
  - Test images transferred to storage server via SSH
  - **Use**: `test_minimal_3_images.zip` from test data
     - **Run Test**: `deadtrees dev test api api/tests/routers/test_upload_odm_zip.py`

- [ ] **VERIFY** Phase 2 Upload Complete
  - Upload detection tests pass: `deadtrees dev test api api/tests/routers/test_upload_odm_detection.py`
  - ZIP processing tests pass: `deadtrees dev test api api/tests/routers/test_upload_odm_zip.py`
  - **STOP** - Do not proceed until Phase 2 tests are passing

### **Task 2.5: Configurable Process Endpoint**

**Context:** Enhance `/datasets/{dataset_id}/process` endpoint to accept task lists from frontend, making it configurable.

**Subtasks:**
- [ ] **CREATE** `ProcessRequest` Pydantic model
  - Field: `task_types: List[TaskTypeEnum]`
  - Validate task types are supported

- [ ] **ENHANCE** `/datasets/{dataset_id}/process` endpoint
  - Accept POST request with ProcessRequest body
  - Build TaskPayload from provided task list
  - Maintain backward compatibility for GET requests

### **Task 2.6: Test Process Endpoint Enhancement**
**Context:** Test the enhanced process endpoint accepts task lists and queues them correctly.

**Subtasks:**
- [ ] **CREATE** `api/tests/routers/test_process_odm.py`
  - Test process endpoint accepts task list: `['odm_processing', 'geotiff', 'cog']`
  - Test TaskPayload created correctly from request
  - Test tasks inserted into queue with correct order
     - **Run Test**: `deadtrees dev test api api/tests/routers/test_process_odm.py`

---

## ⚙️ **PHASE 3: ODM PROCESSING INTEGRATION**

### **Task 3.1: ODM Processing Function**

**Context:** Create ODM processing function that executes ODM containers using Docker-in-Docker with GPU support.

**Subtasks:**
- [ ] **CREATE** `processor/src/process_odm.py`
  - Function: `def process_odm(task: QueueTask, temp_dir: Path)`
  - Pull raw images from storage via SSH from `raw_images/{dataset_id}/images/`
  - Execute ODM Docker container with GPU acceleration using `--fast-orthophoto`
  - Adapt ODM parameters based on RTK detection:
    - Use `--force-gps` flag when RTK data is present
    - Set `--gps-accuracy` to centimeter values (0.01-0.05) based on detected RTK precision
    - Transfer RTK files to ODM project directory for processing use
  - Push generated orthomosaic to storage server at `raw_images/{dataset_id}/odm_orthophoto.tif`
  - Update status tracking (is_odm_done=True)

- [ ] **UPDATE** `processor/requirements.txt`
  - Add `docker>=6.1.0` for Docker API access

### **Task 3.2: Test ODM Processing Function**
**Context:** Test ODM container execution with real drone images and verify orthomosaic generation.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_process_odm.py`
  - Test ODM container execution with minimal image set
  - Test RTK detection and parameter adaptation
  - Test orthomosaic generation and storage transfer
  - Test status tracking updates correctly
  - **Use**: `test_minimal_3_images.zip` fixture
     - **Run Test**: `deadtrees dev test processor processor/tests/test_process_odm.py`

### **Task 3.3: Processor Integration**

**Context:** Integrate ODM processing into main processor execution chain as first step.

**Subtasks:**
- [ ] **ENHANCE** `processor/src/processor.py`
  - Add ODM processing as FIRST step in task execution chain
  - Maintain existing fail-fast error handling pattern
  - Import and call process_odm function

- [ ] **UPDATE** `shared/status.py`
  - Add `is_odm_done: Optional[bool] = None` parameter to update_status function
  - Follow existing parameter pattern

### **Task 3.4: Test Complete ODM Pipeline**
**Context:** Test full pipeline from raw images through ODM to final processing steps.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_odm_pipeline.py`
  - Test complete pipeline: `['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']`
  - Test all database tables updated correctly
  - Test all status flags set correctly
  - Test fail-fast behavior on errors
  - **Use**: `test_small_10_images.zip` for comprehensive testing
     - **Run Test**: `deadtrees dev test processor processor/tests/test_odm_pipeline.py`

### **Task 3.5: Docker Configuration**

**Context:** Configure Docker-in-Docker capability for ODM container execution.

**Subtasks:**
- [ ] **UPDATE** `docker-compose.processor.yaml`
  - Add Docker socket mount: `/var/run/docker.sock:/var/run/docker.sock`
  - Ensure GPU access configuration maintained

- [ ] **UPDATE** processor Dockerfile (if needed)
  - Ensure Docker client available for container execution
  - Maintain existing GDAL and processing environment

### **Task 3.6: Test Docker Configuration**
**Context:** Verify Docker-in-Docker configuration works correctly in test environment.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_docker_config.py`
  - Test Docker socket accessibility from processor container
  - Test ODM image can be pulled and executed
  - Test GPU access works correctly
     - **Run Test**: `deadtrees dev test processor processor/tests/test_docker_config.py`

- [ ] **VERIFY** Phase 3 Complete
  - ODM processing tests pass: `deadtrees dev test processor processor/tests/test_process_odm.py`
  - Complete pipeline tests pass: `deadtrees dev test processor processor/tests/test_odm_pipeline.py`
  - Docker configuration tests pass: `deadtrees dev test processor processor/tests/test_docker_config.py`
  - **STOP** - Do not proceed until Phase 3 tests are passing

---

## 🧪 **PHASE 4: INTEGRATION & VALIDATION**

### **Task 4.1: End-to-End Integration Test**

**Context:** Validate complete workflow from ZIP upload through all processing steps with real data.

**Subtasks:**
- [ ] **CREATE** `integration/tests/test_odm_complete_workflow.py`
  - Test ZIP upload → ODM processing → standardization → segmentation
  - Test both RTK and non-RTK workflows
  - Test error handling and recovery
  - **Use**: `test_medium_25_images.zip` for comprehensive validation
     - **Run Test**: `deadtrees dev test processor integration/tests/test_odm_complete_workflow.py`

### **Task 4.2: Performance & Error Testing**

**Context:** Test resource management, error scenarios, and performance characteristics.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_odm_error_handling.py`
  - Test ODM failure with insufficient images (use `test_invalid_2_images.zip`) - validate minimum 3 images requirement
  - Test Docker socket unavailable scenarios
  - Test storage transfer failures (SSH connection issues with retry mechanism)
  - Test GPU resource unavailability (sequential processing, task queuing)
  - Test invalid ZIP files and unsupported image formats
  - Test cleanup after failures and orphaned container handling
     - **Run Test**: `deadtrees dev test processor processor/tests/test_odm_error_handling.py`

- [ ] **CREATE** `processor/tests/test_odm_performance.py` (marked as slow)
  - Test resource usage monitoring
  - Test processing time benchmarks
  - Test memory and GPU usage
  - **Mark**: `@pytest.mark.slow` for optional execution
  - **Run Test**: `deadtrees dev test processor processor/tests/test_odm_performance.py`

### **Task 4.3: Backward Compatibility Verification**

**Context:** Ensure existing GeoTIFF upload workflow remains unchanged.

**Subtasks:**
- [ ] **CREATE** `api/tests/test_backward_compatibility.py`
  - Test existing GeoTIFF upload workflow unchanged (direct ortho creation → standard pipeline)
  - Test existing processing pipeline unaffected (COG → Thumbnail → Metadata → Segmentation)
  - Test API responses maintain same format
  - Verify GeoTIFF uploads bypass ODM processing entirely
  - Test performance matches existing workflow requirements
     - **Run Test**: `deadtrees dev test api api/tests/test_backward_compatibility.py`

### **Task 4.4: Final Validation**

**Context:** Run comprehensive test suite to validate all functionality before deployment.

**Subtasks:**
- [ ] **RUN** Complete ODM Test Suite
  - Execute: `deadtrees dev test api -m comprehensive`
  - Execute: `deadtrees dev test processor -m comprehensive`
  - Verify all tests pass including slow/comprehensive tests

- [ ] **VERIFY** All Features Working
  - ZIP upload and processing working
  - ODM container execution successful
  - Complete pipeline processing functional
  - Error handling and cleanup working
  - Backward compatibility maintained

---

## 📚 **IMPLEMENTATION DEPENDENCIES**

### **Required Packages**
```txt
# processor/requirements.txt
docker>=6.1.0

# api/requirements.txt  
Pillow>=10.0.0
```

### **Infrastructure Requirements**
- OpenDroneMap Docker image: `opendronemap/odm`
- NVIDIA Container Toolkit on processing server
- Docker socket access for processor container
- Test data created by `scripts/create_odm_test_data.sh`

---

## 🎯 **SUCCESS CRITERIA**

### **Each Phase Completion Criteria**
- [ ] **Phase 1**: Database and model tests pass
- [ ] **Phase 2**: Upload and ZIP processing tests pass
- [ ] **Phase 3**: ODM processing and pipeline tests pass  
- [ ] **Phase 4**: Integration, performance, and compatibility tests pass

### **Final Success Criteria**
- [ ] Users can upload ZIP archive with drone images
- [ ] ODM generates orthomosaic and processes through complete pipeline
- [ ] Acquisition date extracted automatically from EXIF data
- [ ] RTK data detected and used for high-precision processing
- [ ] All tests passing including comprehensive test suite
- [ ] Existing GeoTIFF workflow unchanged and functional

---

**Next Steps:** Begin with Task 0.1 - Create ODM test data, then proceed through phases atomically
**Testing Strategy:** Each task immediately tested before proceeding to next
**Development Workflow:** Use `deadtrees dev test` commands exclusively 