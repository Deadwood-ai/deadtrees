# ODM Raw Drone Image Processing - Implementation Plan

**Version:** 2.0  
**Date:** December 2024  
**Status:** Ready for Implementation - Processor-Centric Architecture

---

## 📋 **IMPLEMENTATION OVERVIEW**

This document outlines the step-by-step implementation plan for integrating OpenDroneMap (ODM) processing into the DeadTrees platform using a **processor-centric architecture** where upload focuses on file storage and all technical analysis happens during processing.

**Key Implementation Principles:**
- **Simplified Upload**: Upload endpoints focus only on file storage, no technical analysis
- **Unified Processing**: Both GeoTIFF and ZIP paths converge at geotiff processing
- **Test-Driven Development**: Each feature is tested immediately after implementation
- **Real Data Testing**: Use actual drone images and coordinates, not mocks
- **Atomic Changes**: One feature + test per task, fully validated before continuing

---

## **Notes**

---

## Rules & Tips
- Always check out `./design.md` and `./requirements.md` for more context. 

- The `shared/models.py` file uses tab indentation (not spaces) - maintain consistency when adding new enum values or model fields
- Task Requirements: Both upload types MUST include 'geotiff' in processing task list
- Storage Paths: GeoTIFF uploads to `archive/{dataset_id}_ortho.tif`, ZIP extraction to `raw_images/{dataset_id}/`
- RTK File Extensions: Detect all RTK file types including `.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU` extensions
- Database RLS Policies: New v2 tables must have RLS policies created separately - standard pattern requires "Enable insert for authenticated users only", "Enable read access for all users", and "Enable update for processor" policies
- ODM Test Data Creation: The `./scripts/create_odm_test_data.sh` script requires `zip` command - install with `sudo apt install -y zip` if missing
- Import Requirements: Future tasks must import `UploadType` and `detect_upload_type()` from `api/src/utils/file_utils.py` (not from routers) to avoid circular dependencies
- Upload Endpoint Testing: When testing chunk upload endpoints with mock data, use intermediate chunks (chunks_total > 1) to avoid final chunk processing that requires valid file formats
- Logging Pattern: Use `logger.method('message', LogContext(category=LogCategory.CATEGORY))` syntax - LogContext is a class requiring instantiation, not an enum with attributes like .PROCESSING
- Test Data Size: Use smaller test files for faster execution - `test_no_rtk_3_images.zip` (25MB) vs `test_minimal_3_images.zip` (1.3GB) reduces test time from 2+ minutes to ~40 seconds
- Obsolete Test Cleanup: When implementing new simplified interfaces, remove old tests that use deprecated function signatures to avoid confusion and false failures
- Function Naming: When expanding functions to handle multiple types, rename from specific names (e.g., `upload_geotiff_chunk`) to generic names (e.g., `upload_chunk`) to reflect broader functionality

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
  - **NOTE**: `geotiff` task type already exists and will handle ortho creation for both sources

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

## 🚀 **PHASE 2: SIMPLIFIED UPLOAD SYSTEM**

### **Task 2.1: File Type Detection Utilities**

**Context:** Need utilities for detecting upload types without complex routing logic.

**Subtasks:**
- [x] **MOVE** `UploadType` enum to `api/src/utils/file_utils.py`
  - Create enum with `GEOTIFF = 'geotiff'` and `RAW_IMAGES_ZIP = 'raw_images_zip'`
  - Remove any existing upload type definitions from routers

- [x] **CREATE** `detect_upload_type()` function in `api/src/utils/file_utils.py`
  - Check file extensions (.tif, .tiff, .zip)
  - Return appropriate UploadType enum
  - Handle unsupported file types with HTTPException

### **Task 2.2: Simplified Upload Router Enhancement**

**Context:** Current endpoint handles chunked GeoTIFF uploads. Simplify by removing all technical analysis.

**Subtasks:**
- [x] **SIMPLIFY** `/datasets/chunk` endpoint in `api/src/routers/upload.py`
  - Add `upload_type: Annotated[Optional[UploadType], Form()] = None` parameter
  - **REMOVE** all technical analysis from final chunk processing:
    - Remove `get_file_identifier()` call
    - Remove `cog_info()` call  
    - Remove `upsert_ortho_entry()` call
  - Route to simplified processing functions based on detected type

- [x] **IMPORT** utilities from `api/src/utils/file_utils.py`
  - Import `UploadType` and `detect_upload_type`
  - Clean up any duplicate enum definitions

### **Task 2.3: Simplified GeoTIFF Upload Processing**

**Context:** Extract and simplify GeoTIFF upload logic, removing all technical analysis.

**Subtasks:**
- [x] **CREATE** `api/src/upload/geotiff_processor.py`
  - Function: `async def process_geotiff_upload(dataset: Dataset, upload_target_path: Path) -> Dataset`
  - **SIMPLIFIED LOGIC**: Only file storage, no technical analysis
    - Move file to `archive/{dataset_id}_ortho.tif`
    - Update status `is_upload_done=True`
    - Return dataset
  - **NO** ortho entry creation, hash calculation, or cog_info analysis

### **Task 2.4: Simplified ZIP Upload Processing**

**Context:** Create ZIP extraction and storage logic without technical analysis.

**Subtasks:**
- [x] **CREATE** `api/src/upload/raw_images_processor.py`
  - Function: `async def process_raw_images_upload(dataset: Dataset, upload_target_path: Path) -> Dataset`
  - **SIMPLIFIED LOGIC**: Extract and store only
    - Extract ZIP to `raw_images/{dataset_id}/`
    - Create basic raw_images database entry
    - Update status `is_upload_done=True`
    - Return dataset
  - **NO** technical analysis during upload

- [x] **CREATE** `api/src/upload/rtk_utils.py`
  - Function: `detect_rtk_files(zip_files: List[str]) -> Dict[str, Any]`
  - Function: `parse_rtk_timestamp_file(mrk_path: Path) -> Dict[str, Any]`
  - Detect RTK files (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
  - Store basic RTK metadata in raw_images entry
  - **NO** complex technical analysis

### **Task 2.5: Test Simplified Upload System**
**Context:** Test simplified upload endpoints with real files.

**Subtasks:**
- [x] **CREATE** `api/tests/routers/test_upload.py`
  - Test GeoTIFF upload creates dataset but NO ortho entry
  - Test ZIP upload creates dataset and raw_images entry only
  - Test file storage in correct locations (archive/ vs raw_images/)
  - Test status updates (is_upload_done=True only)
  - **KEY**: Verify NO ortho entries created during upload
     - **Run Test**: `deadtrees dev test api api/tests/routers/test_upload.py`

- [x] **VERIFY** Phase 2 Upload Complete ✅
  - Upload tests pass: `deadtrees dev test api` (106 passed, 0 failed)
  - Upload speed improved (no technical analysis during upload)
  - Test performance improved (using smaller 25MB test files vs 1.3GB)
  - Both GeoTIFF and ZIP upload processing fully functional
  - **COMPLETE** - Phase 2 upload system verified and working

---

## ⚙️ **PHASE 3: ENHANCED PROCESSOR SYSTEM**

### **Task 3.1: Enhanced GeoTIFF Processing (Critical)**

**Context:** Enhance existing geotiff processing to handle ortho creation for both direct uploads and ODM-generated files.

**Subtasks:**
- [x] **ENHANCE** `processor/src/process_geotiff.py`
  - **ADD** ortho entry creation logic at start of function:
    - Find orthomosaic at `archive/{dataset_id}_ortho.tif`
    - Calculate SHA256 hash with `get_file_identifier()`
    - Extract ortho info with `cog_info()`
    - Create ortho entry with `upsert_ortho_entry()`
  - **MAINTAIN** existing standardization logic
  - **HANDLE** both direct upload and ODM-generated files identically

- [x] **UPDATE** error handling in geotiff processing
  - Add check for missing orthomosaic file
  - Provide clear error messages for missing files
  - Ensure proper cleanup on failures

### **Task 3.2: ODM Processing Function**

**Context:** Create ODM processing function that generates orthomosaic and moves to standard location.

**Subtasks:**
- [ ] **CREATE** `processor/src/process_odm.py`
  - Function: `def process_odm(task: QueueTask, temp_dir: Path)`
  - Pull raw images from storage via SSH from `raw_images/{dataset_id}/`
  - Execute ODM Docker container with GPU acceleration
  - Move generated orthomosaic to `archive/{dataset_id}_ortho.tif`
  - Update status `is_odm_done=True`
  - **NO** ortho entry creation (delegated to geotiff processing)

- [ ] **UPDATE** `processor/requirements.txt`
  - Add `docker>=6.1.0` for Docker API access

### **Task 3.3: Processor Integration**

**Context:** Integrate enhanced processing into main processor execution chain.

**Subtasks:**
- [ ] **ENHANCE** `processor/src/processor.py`
  - Add ODM processing as FIRST step when `odm_processing` in task types
  - **ENSURE** geotiff processing ALWAYS executes for both upload types
  - Maintain existing fail-fast error handling
  - Import and call enhanced process_geotiff and new process_odm

- [ ] **UPDATE** `shared/status.py`
  - Add `is_odm_done: Optional[bool] = None` parameter to update_status function
  - Follow existing parameter pattern

### **Task 3.4: Test Enhanced Processor System**
**Context:** Test unified processing system with both upload types.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_unified_geotiff_processing.py`
  - Test geotiff processing creates ortho entry for direct upload
  - Test geotiff processing creates ortho entry for ODM-generated file
  - Test identical database state after processing regardless of source
  - **KEY**: Verify unified ortho creation logic
     - **Run Test**: `deadtrees dev test processor processor/tests/test_unified_geotiff_processing.py`

- [ ] **CREATE** `processor/tests/test_process_odm.py`
  - Test ODM container execution with minimal image set
  - Test orthomosaic generation and movement to archive/
  - Test status tracking updates correctly
  - **Use**: `test_minimal_3_images.zip` fixture
     - **Run Test**: `deadtrees dev test processor processor/tests/test_process_odm.py`

### **Task 3.5: Docker Configuration**

**Context:** Configure Docker-in-Docker capability for ODM container execution.

**Subtasks:**
- [ ] **UPDATE** `docker-compose.processor.yaml`
  - Add Docker socket mount: `/var/run/docker.sock:/var/run/docker.sock`
  - Ensure GPU access configuration maintained

- [ ] **CREATE** `processor/tests/test_docker_config.py`
  - Test Docker socket accessibility from processor container
  - Test ODM image can be pulled and executed
  - Test GPU access works correctly
     - **Run Test**: `deadtrees dev test processor processor/tests/test_docker_config.py`

- [ ] **VERIFY** Phase 3 Complete
  - Unified geotiff processing tests pass: `deadtrees dev test processor processor/tests/test_unified_geotiff_processing.py`
  - ODM processing tests pass: `deadtrees dev test processor processor/tests/test_process_odm.py`
  - Docker configuration tests pass: `deadtrees dev test processor processor/tests/test_docker_config.py`
  - **STOP** - Do not proceed until Phase 3 tests are passing

---

## 🧪 **PHASE 4: COMPLETE PIPELINE INTEGRATION**

### **Task 4.1: Complete Pipeline Tests**

**Context:** Validate complete workflow from upload through all processing steps with real data.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_complete_pipeline.py`
  - Test complete GeoTIFF pipeline: upload → geotiff → cog → thumbnail → metadata
  - Test complete ZIP pipeline: upload → odm → geotiff → cog → thumbnail → metadata
  - Test identical final database state for both paths
  - **Use**: `test_medium_25_images.zip` for comprehensive validation
     - **Run Test**: `deadtrees dev test processor processor/tests/test_complete_pipeline.py`

### **Task 4.2: Frontend Task Queue Requirements**

**Context:** Ensure frontend includes correct task types for both upload types.

**Subtasks:**
- [ ] **DOCUMENT** required task lists for frontend:
  - **GeoTIFF uploads**: `['geotiff', 'cog', 'thumbnail', 'metadata']`
  - **ZIP uploads**: `['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']`
  - **Critical**: Both must include 'geotiff' for ortho entry creation

- [ ] **CREATE** validation in process endpoint
  - Verify 'geotiff' included in task list for all uploads
  - Provide clear error if geotiff task missing
  - Add helpful documentation in API responses

### **Task 4.3: Backward Compatibility Verification**

**Context:** Ensure existing workflows continue working with enhanced processing.

**Subtasks:**
- [ ] **CREATE** `api/tests/test_backward_compatibility.py`
  - Test existing GeoTIFF upload workflow (now simplified)
  - Test processing pipeline produces identical results
  - Test API responses maintain same format
  - Verify performance improvements from simplified upload
     - **Run Test**: `deadtrees dev test api api/tests/test_backward_compatibility.py`

### **Task 4.4: Error Handling and Edge Cases**

**Context:** Test error scenarios and edge cases for robust operation.

**Subtasks:**
- [ ] **CREATE** `processor/tests/test_error_handling.py`
  - Test missing orthomosaic file in archive/ directory
  - Test ODM failure with insufficient images
  - Test Docker socket unavailable scenarios
  - Test cleanup after failures
     - **Run Test**: `deadtrees dev test processor processor/tests/test_error_handling.py`

### **Task 4.5: Final Integration Validation**

**Context:** Run comprehensive test suite to validate all functionality before deployment.

**Subtasks:**
- [ ] **RUN** Complete Test Suite
  - Execute: `deadtrees dev test api -m comprehensive`
  - Execute: `deadtrees dev test processor -m comprehensive`
  - Verify all tests pass including performance improvements

- [ ] **VERIFY** All Features Working
  - Simplified upload endpoints functional
  - Unified geotiff processing creates ortho entries for both sources  
  - Complete pipeline processing functional
  - Error handling and cleanup working
  - Performance improvements measurable

---

## 📚 **IMPLEMENTATION DEPENDENCIES**

### **Required Packages**
```txt
# processor/requirements.txt
docker>=6.1.0

# api/requirements.txt  
# No new requirements needed
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
- [ ] **Phase 2**: Simplified upload tests pass, performance improved
- [ ] **Phase 3**: Unified processing tests pass, both sources handled identically  
- [ ] **Phase 4**: Integration tests pass, backward compatibility maintained

### **Final Success Criteria**
- [ ] Both GeoTIFF and ZIP uploads work with simplified, fast upload process
- [ ] All technical analysis happens in processor, eliminating code duplication
- [ ] Both upload types result in identical database state after geotiff processing
- [ ] ODM generates orthomosaic and integrates seamlessly with processing pipeline
- [ ] Upload performance improved due to eliminated technical analysis
- [ ] Processing behavior identical regardless of orthomosaic source
- [ ] All tests passing including comprehensive test suite

---

## 🔄 **ARCHITECTURAL BENEFITS**

### **Upload Simplification**
- **Faster uploads**: No technical analysis during upload
- **Higher reliability**: Fewer failure points during upload
- **Cleaner code**: Upload focused on file storage only

### **Unified Processing**
- **No code duplication**: Single technical analysis logic in processor
- **Consistent behavior**: Identical processing regardless of source
- **Easier maintenance**: Single code path for ortho creation

### **Database Consistency**
- **Unified state**: Both upload types result in identical database state
- **Predictable behavior**: Same processing pipeline for both sources
- **Simpler testing**: Single set of validation logic

---

**Next Steps:** Begin with Task 0.1 - Create ODM test data, then proceed through phases atomically
**Testing Strategy:** Each task immediately tested before proceeding to next
**Development Workflow:** Use `deadtrees dev test` commands exclusively 
**Architecture Principle:** Upload stores files, processor creates ortho entries and performs all technical analysis 