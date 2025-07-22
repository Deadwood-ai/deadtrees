# ODM Raw Drone Image Processing - Implementation Plan

**Version:** 1.0  
**Date:** December 2024  
**Status:** Ready for Implementation

---

## 📋 **IMPLEMENTATION OVERVIEW**

This document outlines the step-by-step implementation plan for integrating OpenDroneMap (ODM) processing into the DeadTrees platform. The implementation is divided into 4 phases with specific tasks, subtasks, and context information.

**Key Implementation Principles:**
- Enhance existing systems rather than rebuild
- Maintain backward compatibility with current workflows
- Follow established patterns from existing processing functions
- Use incremental deployment approach

---


## **Notes**


## Rules & Tips

- The `shared/models.py` file uses tab indentation (not spaces) - maintain consistency when adding new enum values or model fields



## 🗂️ **PHASE 1: DATABASE & MODEL FOUNDATION**

### **Task 1.1: Database Schema Implementation**

**Context:** The system uses v2_ prefixed tables with Supabase PostgreSQL. Current task types: `cog`, `thumbnail`, `deadwood`, `geotiff`, `metadata`.

**Subtasks:**
- [x] Create sql commands to create the tables, so that i can run them in the supabase editor. 
  - Create new v2_raw_images table following established v2_* patterns
  - Include proper indexing and foreign key constraints
  - Reference existing migration patterns in `supabase/migrations/`

```sql
-- Migration content:
CREATE TABLE "public"."v2_raw_images" (
    "dataset_id" bigint NOT NULL REFERENCES "public"."v2_datasets"(id) ON DELETE CASCADE,
    "raw_image_count" integer NOT NULL,
    "raw_image_size_mb" integer NOT NULL,
    "raw_images_path" text NOT NULL, -- Contains both images and RTK files
    "camera_metadata" jsonb,
    "has_rtk_data" boolean NOT NULL DEFAULT false,
    "rtk_precision_cm" numeric(4,2),
    "rtk_quality_indicator" integer,
    "rtk_file_count" integer DEFAULT 0,
    "version" integer NOT NULL DEFAULT 1,
    "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Add RLS
ALTER TABLE "public"."v2_raw_images" ENABLE ROW LEVEL SECURITY;

-- Indexes following v2_* patterns  
CREATE UNIQUE INDEX v2_raw_images_pkey ON public.v2_raw_images USING btree (dataset_id);
ALTER TABLE "public"."v2_raw_images" ADD CONSTRAINT "v2_raw_images_pkey" PRIMARY KEY using index "v2_raw_images_pkey";

-- RLS Policies (copy from existing v2_* tables)
-- Grant permissions following existing v2_* table patterns
```

**Benefits of Separate Table:**
- Clean separation: v2_datasets for final data, v2_raw_images for input material
- Follows established foreign key patterns (dataset_id → v2_datasets.id)
- No impact on existing v2_datasets semantics or queries
- Scalable for different upload volumes (more orthos vs raw uploads)

- [x] Create `supabase/migrations/YYYYMMDDHHMMSS_add_odm_status_tracking.sql`
  - Add `odm_processing` to v2_status enum type
  - Add `is_odm_done` boolean flag to v2_statuses table
  - Follow pattern from existing status migrations (20250123150750_adding_new_metadata_status.sql)

```sql
-- Add ODM processing status to enum (follows existing pattern)
ALTER TYPE "public"."v2_status" ADD VALUE 'odm_processing';

-- Add ODM completion flag (follows existing is_*_done pattern)
ALTER TABLE "public"."v2_statuses" ADD COLUMN "is_odm_done" boolean NOT NULL DEFAULT false;
```

**Implementation Context:**
- Database uses RLS (Row Level Security) with processor and user access patterns
- Follow existing naming conventions (snake_case, v2_ prefix)
- Use proper indexing strategy for performance (GIN index for JSONB)
- No additional RLS policies needed - raw image data covered by existing v2_datasets policies

### **Task 1.2: Shared Models Extension**

**Context:** Models in `shared/models.py` use Pydantic with enum validation. Current TaskTypeEnum has 5 values: cog, thumbnail, deadwood, geotiff, metadata.

**Subtasks:**
- [x] **ADD** `odm_processing` to `TaskTypeEnum` in `shared/models.py`
  - Add `odm_processing = 'odm_processing'`
  - Maintain alphabetical order for consistency
  - **NOTE**: `geotiff` task type already exists and will be used for ODM output standardization

```python
class TaskTypeEnum(str, Enum):
    cog = 'cog'                        # Existing
    deadwood = 'deadwood'              # Existing  
    geotiff = 'geotiff'                # Existing - will standardize ODM outputs
    metadata = 'metadata'              # Existing
    odm_processing = 'odm_processing'  # NEW - Always first in execution
    thumbnail = 'thumbnail'            # Existing
```

- [x] **ADD** `odm_processing` to `StatusEnum` in `shared/models.py`  
  - Add `odm_processing = 'odm_processing'`
  - Follow existing status naming patterns

```python
class StatusEnum(str, Enum):
    idle = 'idle'                                    # Existing
    uploading = 'uploading'                          # Existing
    ortho_processing = 'ortho_processing'            # Existing
    cog_processing = 'cog_processing'                # Existing
    metadata_processing = 'metadata_processing'      # Existing
    thumbnail_processing = 'thumbnail_processing'    # Existing
    deadwood_segmentation = 'deadwood_segmentation'  # Existing
    forest_cover_segmentation = 'forest_cover_segmentation'  # Existing
    audit_in_progress = 'audit_in_progress'          # Existing
    odm_processing = 'odm_processing'                # NEW
```

- [ ] **ADD** `RawImages` Pydantic model in `shared/models.py`
  - Create new RawImages model for separate v2_raw_images table
  - Include proper field validation and serializers
  - Follow existing model patterns from other v2_* models

```python
class RawImages(BaseModel):
    id: Optional[int] = None
    dataset_id: int
    raw_image_count: int
    raw_image_size_mb: int
    raw_images_path: str  # Contains both images and RTK files
    camera_metadata: Optional[Dict[str, Any]] = None
    has_rtk_data: bool = False
    rtk_precision_cm: Optional[float] = None
    rtk_quality_indicator: Optional[int] = None
    rtk_file_count: int = 0
    version: int = 1
    created_at: Optional[datetime] = None
    
    @field_serializer('created_at', mode='plain')
    def datetime_to_isoformat(field: datetime | None) -> str | None:
        if field is None:
            return None
        return field.isoformat()
```

- [ ] **EXTEND** `Status` Pydantic model in `shared/models.py`
  - Add `is_odm_done: bool = False` field
  - Follow existing boolean flag pattern (is_cog_done, is_thumbnail_done, etc.)

```python
class Status(BaseModel):
    # ... existing fields ...
    is_odm_done: bool = False  # NEW - follows existing is_*_done pattern
```

**Implementation Context:**
- Maintain existing validation patterns and field serializers
- Ensure datetime fields use proper ISO format serialization
- Use Dict[str, Any] for camera_metadata to handle flexible EXIF data
- Follow optional field patterns used in existing Dataset model

---

## 🚀 **PHASE 2: UPLOAD SYSTEM ENHANCEMENT**

### **Task 2.1: Enhanced Upload Endpoint**

**Context:** Current endpoint at `api/src/routers/upload.py` handles chunked GeoTIFF uploads. Uses file detection and metadata creation patterns.

**Subtasks:**
- [ ] Create `UploadType` enum in `api/src/routers/upload.py`
  - Values: `GEOTIFF = 'geotiff'`, `RAW_IMAGES_ZIP = 'raw_images_zip'`

- [ ] Implement `detect_upload_type()` function
  - Check file extensions (.tif, .tiff, .zip)
  - Return appropriate UploadType enum
  - Handle unsupported file types with HTTPException

- [ ] Add optional `upload_type` parameter to `/datasets/chunk` endpoint
  - Use `Annotated[Optional[UploadType], Form()]` pattern
  - Maintain backward compatibility (auto-detect if not provided)

- [ ] Refactor final chunk processing logic
  - Extract current GeoTIFF logic to `process_geotiff_upload()`
  - Add routing logic for detected upload types
  - Maintain existing error handling patterns

**Implementation Context:**
- Follow existing upload patterns for chunked file handling
- Use existing authentication and logging patterns
- Maintain all current metadata fields and validation
- Keep same response format for backward compatibility

### **Task 2.2: ZIP Processing Implementation**

**Context:** Need to extract ZIP files, validate images, extract comprehensive EXIF data, and transfer to storage server using existing SSH utilities. **CRITICAL**: ZIP processing must happen directly in upload endpoint with immediate task queueing.

**Subtasks:**
- [ ] Create `api/src/upload/raw_images_processor.py`
  - Function: `async def process_raw_images_upload(...) -> Dataset`
  - Handle ZIP extraction and validation
  - Follow error handling patterns from existing upload code
  - **QUEUE ODM TASKS DIRECTLY** - no separate process endpoint call

- [ ] Implement ZIP extraction and validation
  - Extract to temporary directory using Python `zipfile`
  - Validate file formats: JPEG, JPG, TIF (case-insensitive) and RTK files (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
  - Minimum 3 images requirement validation
  - Calculate total file size and image count
  - Detect and count RTK auxiliary files

- [ ] Create `api/src/upload/exif_utils.py`
  - Function: `extract_comprehensive_exif(image_path: Path) -> Dict[str, Any]`
  - Function: `extract_acquisition_date(image_path: Path) -> Optional[datetime]`
  - Use PIL (Pillow) for comprehensive EXIF extraction
  - Extract camera make/model, GPS coordinates, flight details, image settings
  - Handle missing/corrupted EXIF gracefully

- [ ] Create `api/src/upload/rtk_utils.py`
  - Function: `detect_rtk_files(zip_files: List[str]) -> Dict[str, Any]`
  - Function: `parse_rtk_timestamp_file(mrk_path: Path) -> Dict[str, Any]`
  - Detect RTK file extensions (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
  - Parse .MRK timestamp files to extract precision indicators and quality metrics
  - Extract RTK precision values (horizontal/vertical accuracy in centimeters)
  - Extract RTK quality indicators (Q values: 50=excellent RTK fix)

- [ ] Implement SSH transfer for raw images and RTK files
  - Use existing SSH utilities from `processor/src/utils/ssh.py`
  - Transfer all ZIP contents to unified `raw_images/{dataset_id}/images/` directory structure
  - Preserve original ZIP structure with images and RTK files together
  - Follow established SSH connection and error handling patterns

- [ ] Create enhanced dataset and raw images database entries
  - Create v2_datasets entry with acquisition date from EXIF extraction
  - Create separate v2_raw_images entry with metadata and counts
  - Store comprehensive EXIF data in **v2_raw_images.camera_metadata** JSONB field
  - Store RTK metadata: has_rtk_data, rtk_precision_cm, rtk_quality_indicator, rtk_file_count
  - Link via foreign key: v2_raw_images.dataset_id → v2_datasets.id

**Implementation Context:**
- Leverage existing SSH utilities and connection management
- Follow existing temporary file cleanup patterns
- Use existing logging and error handling from `shared/logging.py`
- Maintain dataset creation patterns from `api/src/upload/upload.py`
- Store rich EXIF metadata in **v2_raw_images.camera_metadata** for future use

### **Task 2.3: Task Queue Integration - UPDATED APPROACH**

**Context:** Current system queues tasks via `/datasets/{dataset_id}/process` endpoint. This endpoint will be enhanced to be configurable by the frontend, allowing it to handle both GeoTIFF and raw image workflows.

**Subtasks:**
- [ ] Modify `/datasets/{dataset_id}/process` endpoint to accept a POST request with a list of task types.
  - Create a Pydantic model (`ProcessRequest`) to validate the incoming `task_types: List[TaskTypeEnum]`.
  - Use the provided list to build the `TaskPayload` and insert it into the queue.
- [ ] Ensure the `process_raw_images_upload` function does **NOT** queue any tasks. Its only responsibility is file handling and database entry creation.
- [ ] The frontend will be responsible for calling the `/process` endpoint with the correct task list (`['odm_processing', 'geotiff', ...]`) after a successful ZIP upload.

**Implementation Context:**
- This approach makes the backend simpler and more flexible.
- It centralizes the task queuing logic into a single, configurable endpoint.
- Maintains consistency with the existing GeoTIFF upload workflow.

---

## ⚙️ **PHASE 3: ODM PROCESSING INTEGRATION**

### **Task 3.1: ODM Processing Function**

**Context:** Processor runs in Docker with SSH access to storage server and Docker socket mount. Current processing functions follow established patterns for file transfer and error handling.

**Subtasks:**
- [ ] Create `processor/src/process_odm.py`
  - Function: `def process_odm(task: QueueTask, temp_dir: Path)`
  - Follow existing processing function patterns
  - Use established authentication and logging patterns

- [ ] Implement raw image and RTK data retrieval
  - Use existing SSH utilities to pull all files from storage (images + RTK files)
  - Pull from unified `raw_images/{dataset_id}/images/` directory
  - Preserve original ZIP structure with RTK files alongside images
  - Follow file transfer patterns from other processors

- [ ] Implement ODM Docker container execution using Docker-in-Docker
  - Use Docker API (docker-py) for container management
  - Mount temporary directory for image and RTK file access
  - Configure GPU support with device requests (GPU sharing confirmed to work)
  - Query database for RTK metadata to adapt ODM command parameters
  - Use RTK-aware command construction with `--force-gps` and `--gps-accuracy` flags

```python
import docker
from shared.models import RawImages

def process_odm(task: QueueTask, temp_dir: Path):
    # Query RTK metadata from database
    raw_images = get_raw_images_by_dataset_id(task.dataset_id)
    
    # Build RTK-aware ODM command
    command = ["--fast-orthophoto", "--project-path", "/project", str(dataset_id)]
    
    if raw_images.has_rtk_data:
        command.extend([
            "--force-gps",  # Use high-precision GPS over GCPs
            "--gps-accuracy", str(raw_images.rtk_precision_cm / 100)  # Convert cm to meters
        ])
    
    client = docker.from_env()
    container = client.containers.run(
        image="opendronemap/odm",
        command=command,
        volumes={str(project_dir): {"bind": "/project", "mode": "rw"}},
        device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
        detach=True,
        remove=True
    )
    # Wait for completion and handle results
```

- [ ] Handle ODM output processing
  - Extract generated orthomosaic from container output
  - Push to storage server at `archive/{dataset_id}_ortho.tif`
  - Create ortho entry in database
  - Update status: `is_upload_done=True`

- [ ] Integrate with v2_statuses tracking system
  - Use existing `update_status()` function from `shared/status.py`
  - Set `current_status=StatusEnum.odm_processing` at start
  - Set `is_odm_done=True` on completion
  - Set `has_error=True` and `error_message` on failure
  - Follow same pattern as `process_deadwood_segmentation()`

```python
# Example status integration
from shared.status import update_status
from shared.models import StatusEnum

def process_odm(task: QueueTask, token: str, temp_dir: Path):
    # Start processing
    update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.odm_processing)
    
    try:
        # ODM processing logic...
        
        # Mark complete
        update_status(token, dataset_id=task.dataset_id, 
                     current_status=StatusEnum.idle, is_odm_done=True)
                     
    except Exception as e:
        # Mark error
        update_status(token, dataset_id=task.dataset_id,
                     current_status=StatusEnum.idle, has_error=True, 
                     error_message=str(e))
        raise
```

**Implementation Context:**
- Follow existing processor patterns from `process_geotiff.py`, `process_cog.py`
- Use established error handling and logging from `shared/logging.py`
- Maintain SSH connection patterns and retry logic
- Follow same status tracking pattern as existing processor functions
- Docker-in-Docker GPU sharing confirmed to work with sequential processing

### **Task 3.2: Processor Integration**

**Context:** Main processor in `processor/src/processor.py` handles task routing and execution. It uses a fail-fast chain of `try...except` blocks, which correctly ensures that a failure in one step stops the entire process for that task.

**Subtasks:**
- [ ] Add the `odm_processing` task as the **first step** in the `process_task` execution chain in `processor.py`.
  - This ensures ODM processing runs before any other step.
  - The existing fail-fast error handling will automatically apply. If `process_odm` fails, no subsequent steps (geotiff, cog, etc.) will be executed.

```python
# processor.py - Add ODM to the existing fail-fast chain
def process_task(task: QueueTask, token: str):
    # ...
    try:
        # 1. Add ODM processing as the FIRST step
        if TaskTypeEnum.odm_processing in task.task_types:
            try:
                logger.info('Starting ODM processing...')
                process_odm(task, settings.processing_path)
            except Exception as e:
                logger.error(f'ODM processing failed: {str(e)}')
                raise ProcessingError(str(e), task_type='odm_processing', ...)
        
        # 2. Existing geotiff processing and other tasks follow
        if TaskTypeEnum.geotiff in task.task_types:
            # ... existing logic ...

        # ... etc.
```

- [ ] Add Docker dependency to processor
  - Update `processor/requirements.txt` with `docker>=6.1.0`
  - Ensure Docker socket access in container configuration

- [ ] **UPDATE DOCKER COMPOSE CONFIGURATION**
  - Add Docker socket mount to `docker-compose.processor.yaml`
  - Required for Docker-in-Docker ODM container execution

```yaml
# docker-compose.processor.yaml - ADD this volume:
volumes:
  - /var/run/docker.sock:/var/run/docker.sock  # Enable Docker-in-Docker
```

- [ ] **FIX STATUS FUNCTION SIGNATURE**
  - Current `shared/status.py update_status()` function lacks `is_odm_done` parameter
  - Must add this parameter to match existing pattern

```python
# shared/status.py - ADD missing parameter:
def update_status(
    token: str,
    dataset_id: int,
    current_status: Optional[StatusEnum] = None,
    is_upload_done: Optional[bool] = None,
    is_ortho_done: Optional[bool] = None,
    is_cog_done: Optional[bool] = None,
    is_thumbnail_done: Optional[bool] = None,
    is_deadwood_done: Optional[bool] = None,
    is_forest_cover_done: Optional[bool] = None,
    is_metadata_done: Optional[bool] = None,
    is_odm_done: Optional[bool] = None,  # ADD THIS LINE
    is_audited: Optional[bool] = None,
    has_error: Optional[bool] = None,
    error_message: Optional[str] = None,
):
```

**Implementation Context:**
- **Correction:** The original analysis of the processor's execution order was incorrect. The existing `raise` statements correctly create a fail-fast workflow. No major refactoring is needed.
- The only change required is to insert the `process_odm` logic at the beginning of the `try` block in `process_task`.
- Maintain current error handling and cleanup procedures.
- Use established logging patterns for task lifecycle.
- Ensure proper token refresh patterns are maintained

### **Task 3.3: Docker Configuration**

**Context:** Processor runs in containerized environment. Need Docker-in-Docker capability for ODM container execution. User accepts security implications.

**Subtasks:**
- [ ] Update processor Dockerfile
  - Ensure Docker client installation for Docker API access
  - Install any additional dependencies for ODM
  - Maintain existing GDAL and Python environment

- [ ] Configure Docker Compose for development
  - Mount `/var/run/docker.sock` to processor container
  - Ensure GPU access configuration (confirmed working with sequential processing)
  - Maintain existing volume mounts and environment variables

```yaml
# docker-compose.test.yaml additions
processor-test:
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock  # Enable Docker-in-Docker
  # ... existing configuration
```

- [ ] Update production deployment configuration
  - Configure NVIDIA Container Toolkit access
  - Ensure proper Docker socket permissions
  - Plan resource limits for ODM containers

**Implementation Context:**
- Follow existing containerization patterns
- Maintain current development workflow compatibility
- Security implications accepted by user for this environment
- GPU sharing between parent and child containers confirmed to work

---

## 🧪 **PHASE 4: TESTING & VALIDATION**

### **Task 4.1: Critical Path Testing**

**Context:** Follow established integration-focused testing patterns using real data. Focus on most critical functionality for fast error detection during development.

**Subtasks:**
- [ ] Create `api/tests/routers/test_upload_odm.py`
  - **Primary Test**: `test_zip_upload_creates_entries()` - ZIP chunked upload → v2_datasets + v2_raw_images creation
  - **EXIF Test**: `test_zip_acquisition_date_extraction()` - Verify acquisition date from ZIP images
  - **Storage Test**: `test_zip_images_transferred_to_storage()` - SSH transfer verification
  - Use existing chunked upload test patterns from `test_upload.py`

- [ ] Create `processor/tests/test_process_odm.py`
  - **Core Test**: `test_odm_container_execution()` - Docker-in-Docker ODM execution
  - **Integration Test**: `test_odm_generates_orthomosaic()` - Verify output file creation and transfer
  - **Status Test**: `test_odm_status_tracking()` - Verify `is_odm_done` flag updates
  - Follow existing processor test patterns from `test_process_cog.py`

- [ ] Create `processor/tests/test_odm_pipeline.py` 
  - **Pipeline Test**: `test_complete_zip_to_cog_pipeline()` - Full workflow test
  - Use comprehensive testing pattern from `test_process_cog.py::test_comprehensive_all_small_files_pipeline`
  - Process task types: `['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']`
  - Verify all database tables updated correctly

**Implementation Context:**
- Use existing `test_dataset_for_processing` fixture pattern
- Follow established cleanup procedures with try/finally blocks
- Use real drone image ZIP files from `assets/test_data/raw_drone_images/`
- Apply existing test markers: `@pytest.mark.odm`, `@pytest.mark.slow`, `@pytest.mark.comprehensive`

### **Task 4.2: Test Data & Fixtures Setup**

**Context:** Create minimal real test data following existing patterns in `assets/test_data/` and `shared/testing/fixtures.py`.

**Subtasks:**
- [ ] Create test drone image ZIP files from available 277 DJI images + RTK data (~2.6GB total)
  - `test_minimal_3_images.zip` - Minimal valid set (3 images + RTK files, ~30MB)
  - `test_small_10_images.zip` - Development testing (10 images + RTK files, ~100MB)
  - `test_medium_25_images.zip` - Comprehensive testing (25 images + RTK files, ~250MB)
  - `test_invalid_2_images.zip` - Error testing (2 images + RTK files, insufficient for ODM)
  - `test_no_rtk_3_images.zip` - Testing without RTK data (3 images only, for comparison)
  - Source: `assets/test_data/raw_drone_images/DJI_202504031231_008_hartheimwithbuffer60m/` (277 DJI images + RTK files available)

- [ ] Create ODM test fixtures following existing patterns
  ```python
  # processor/tests/conftest.py - ADD
  @pytest.fixture
  def test_raw_images_zip_minimal():
      """Provide minimal ZIP file (3 DJI images ~30MB)"""
      zip_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_3_images.zip'
      if not zip_path.exists():
          pytest.skip('Minimal drone images ZIP not found - run creation script')
      return zip_path

  @pytest.fixture
  def test_raw_images_zip_small():
      """Provide small ZIP file (10 DJI images ~100MB) for development"""
      zip_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'raw_drone_images' / 'test_small_10_images.zip'
      if not zip_path.exists():
          pytest.skip('Small drone images ZIP not found - run creation script')
      return zip_path

  @pytest.fixture
  def test_dataset_with_raw_images(auth_token, test_raw_images_zip_minimal, test_processor_user):
      """Create dataset with raw images and RTK data (follows test_dataset_for_processing pattern)"""
      # Create v2_datasets entry (acquisition date: 2025-04-03 from DJI EXIF)
      # Extract ZIP and create v2_raw_images entry (3 images + RTK files, ~30MB)
      # Set RTK metadata: has_rtk_data=True, rtk_precision_cm=2.0, rtk_quality_indicator=50
      # Transfer all files to storage server: raw_images/{dataset_id}/images/
      # Yield dataset_id
      # Cleanup in finally block
  ```

**Implementation Context:**
- Follow existing fixture patterns from `processor/tests/conftest.py::test_dataset_for_processing`
- Use established cleanup patterns with database cascade deletes
- Maintain test environment safety checks from `shared/testing/safety.py`

### **Task 4.3: Error & Performance Testing**

**Context:** Test critical failure scenarios and resource management following existing error testing patterns.

**Subtasks:**
- [ ] Create error handling tests
  - `test_odm_container_failure()` - Invalid image sets, insufficient overlap
  - `test_docker_socket_unavailable()` - Docker daemon not accessible
  - `test_storage_transfer_failure()` - SSH connection issues
  - Follow existing error testing patterns from processor tests

- [ ] Create performance tests (marked as `@pytest.mark.slow`)
  - `test_odm_with_large_image_set()` - Resource usage monitoring
  - `test_odm_cleanup_after_failure()` - Verify no resource leaks
  - Follow existing slow test patterns from `test_process_cog.py`

**Implementation Context:**
- Use existing error handling verification from processor tests
- Follow established performance testing patterns
- Maintain existing test isolation between test runs

### **Task 4.4: Test Execution Strategy**

**Context:** Enable fast development feedback and comprehensive validation using established CLI patterns.

**Development Testing:**
```bash
# Quick critical path during development (uses test_minimal_3_images.zip ~30MB)
deadtrees dev test api --test-path=api/tests/routers/test_upload_odm.py::test_zip_upload_creates_entries

# ODM core functionality (uses test_minimal_3_images.zip ~30MB)
deadtrees dev test processor --test-path=processor/tests/test_process_odm.py::test_odm_container_execution

# Complete workflow verification (uses test_small_10_images.zip ~100MB for faster processing)
deadtrees dev test processor --test-path=processor/tests/test_odm_pipeline.py::test_complete_zip_to_cog_pipeline
```

**Comprehensive Testing:**
```bash
# All ODM tests (excludes slow tests by default)
pytest processor/tests/test_*odm*.py

# Include slow/comprehensive tests
pytest -m "odm and comprehensive" processor/tests/

# Full pipeline validation (like existing comprehensive tests)
pytest -m comprehensive
```

**Implementation Context:**
- Follow existing test execution patterns from `deadtrees-cli/deadtrees_cli/dev.py`
- Use established test markers and filtering
- Maintain existing test environment management

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
- Additional storage capacity for raw images
- SSH connectivity between processing and storage servers

### **Configuration Updates**
- Docker Compose: Mount Docker socket and GPU access
- Environment variables: ODM processing settings
- SSH keys: Ensure proper access between servers
- Storage directories: Create raw_images structure

---

## 🎯 **SUCCESS CRITERIA**

### **Phase 1 Completion**
- [ ] Database migrations successfully applied
- [ ] Models updated and validated
- [ ] No breaking changes to existing functionality

### **Phase 2 Completion**  
- [ ] ZIP uploads working via chunked endpoint
- [ ] EXIF date extraction functional
- [ ] Raw images stored on storage server
- [ ] ODM tasks properly queued

### **Phase 3 Completion**
- [ ] ODM containers execute successfully
- [ ] Generated orthomosaics stored and processed
- [ ] Complete processing pipeline functional
- [ ] Error handling and cleanup working

### **Phase 4 Completion**
- [ ] All tests passing
- [ ] Performance benchmarks met
- [ ] Documentation complete
- [ ] Production deployment ready

---

## ⚠️ **CRITICAL IMPLEMENTATION NOTES**

### **Backward Compatibility**
- Existing GeoTIFF upload workflow MUST remain unchanged
- API responses must maintain current format
- No breaking changes to task types or queue system

### **Security Considerations**
- Docker socket access requires careful security review
- ZIP file validation to prevent malicious uploads
- Resource limits for ODM containers
- SSH key management and rotation

### **Performance Considerations**
- Sequential ODM processing (one container at a time)
- Monitor storage growth for raw images
- 24-hour timeout for ODM processing
- GPU resource management and scheduling

### **Error Handling**
- Graceful degradation when ODM fails
- Clear error messages for users
- Automatic cleanup of temporary files
- Retry mechanisms for transient failures

---

## 📱 **FRONTEND IMPLEMENTATION**

Frontend implementation for EXIF extraction and upload interface enhancements is documented separately:

**📄 See: [Frontend Implementation Guide](./frontend-implementation.md)**

- EXIF extraction utilities for automatic acquisition date detection
- ZIP validation and preview functionality
- Upload interface enhancements for raw drone images
- User experience improvements and error handling

---

**Next Steps:** Begin with Phase 1 database and model implementation
**Estimated Timeline:** 4-6 weeks for complete backend implementation
**Required Resources:** Backend developer, DevOps support, testing environment access 