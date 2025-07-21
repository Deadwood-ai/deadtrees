# ODM Raw Drone Image Processing - Technical Design

**Version:** 2.0  
**Date:** December 2024  
**Status:** ✅ Ready for Implementation

---

## 🏗️ **ARCHITECTURE OVERVIEW**

### **Core Decisions**
- **Unified Upload**: Enhance existing `/datasets/chunk` endpoint for both GeoTIFF and ZIP
- **Smart Routing**: Automatic file type detection (.tif vs .zip) 
- **Quality Pipeline**: Keep GeoTIFF standardization for ODM outputs
- **No EXIF Table**: Capture acquisition date in existing tables only

### **Processing Flows**
```
GeoTIFF: .tif → [geotiff→cog→thumb→metadata→deadwood]
ZIP:     .zip → [odm→geotiff→cog→thumb→metadata→deadwood]
```

---

## 🗄️ **DATABASE SCHEMA**

### **Separate v2_raw_images Table - Following Established Patterns**
Clean separation following existing v2_* table architecture:

```sql
-- New table for raw drone image metadata
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

-- Indexes and constraints following v2_* patterns
CREATE UNIQUE INDEX v2_raw_images_pkey ON public.v2_raw_images USING btree (dataset_id);
ALTER TABLE "public"."v2_raw_images" ADD CONSTRAINT "v2_raw_images_pkey" PRIMARY KEY using index "v2_raw_images_pkey";
```

### **Status System Integration - Following Existing Patterns**
Extend v2_statuses table using established patterns:

```sql
-- Add ODM processing status to enum (matches existing pattern)
ALTER TYPE "public"."v2_status" ADD VALUE 'odm_processing';

-- Add ODM completion flag (matches is_*_done pattern)  
ALTER TABLE "public"."v2_statuses" ADD COLUMN "is_odm_done" boolean NOT NULL DEFAULT false;
```

**Status Integration Benefits:**
- **Consistent tracking**: Same pattern as is_cog_done, is_thumbnail_done, etc.
- **Unified error handling**: Uses existing has_error/error_message system
- **Queue compatible**: Works with current task execution flow
- **Monitoring ready**: Integrates with existing status monitoring

**Storage Path Convention:**
- Raw images + RTK files: `raw_images/{dataset_id}/images/` (unified directory for all ZIP contents)
- Generated ortho: `raw_images/{dataset_id}/odm_orthophoto.tif`
- Matches existing storage patterns and preserves original ZIP structure

### **Frontend EXIF Extraction - Smart UX**
```typescript
// Frontend extraction during file selection
const extractAcquisitionDate = (imageFile: File) => {
  // Use exif-js or similar library
  EXIF.getData(imageFile, function() {
    const dateTime = EXIF.getTag(this, "DateTimeOriginal");
    // Parse and validate date
    // Populate form fields immediately
  });
};
```

**Benefits:**
- **Immediate validation**: Users see acquisition date before upload
- **Reduced server load**: No EXIF processing during upload
- **Better UX**: Instant feedback and error handling
- **Consistent data**: Standardized date format

---

## 🔧 **IMPLEMENTATION COMPONENTS**

### **1. Enhanced Upload Endpoint**
```python
# api/src/routers/upload.py

class UploadType(str, Enum):
    GEOTIFF = 'geotiff'
    RAW_IMAGES_ZIP = 'raw_images_zip'

def detect_upload_type(file_path: Path) -> UploadType:
    if file_path.suffix.lower() in ['.tif', '.tiff']:
        return UploadType.GEOTIFF
    elif file_path.suffix.lower() == '.zip':
        return UploadType.RAW_IMAGES_ZIP
    else:
        raise HTTPException(400, f"Unsupported file type: {file_path.suffix}")

@router.post('/datasets/chunk')  # ENHANCED existing endpoint
async def upload_chunk(
    # ... existing parameters ...
    upload_type: Annotated[Optional[UploadType], Form()] = None,  # NEW
):
    # ... existing chunk logic ...
    
    # Final chunk processing with smart routing
    if chunk_index == chunks_total - 1:
        detected_type = upload_type or detect_upload_type(upload_target_path)
        
        if detected_type == UploadType.GEOTIFF:
            return await process_geotiff_upload(...)
        elif detected_type == UploadType.RAW_IMAGES_ZIP:
            return await process_raw_images_upload(...)
```

### **2. Upload Processing Functions**
```python
# api/src/upload/geotiff_processor.py
async def process_geotiff_upload(...) -> Dataset:
    """Extract existing GeoTIFF upload logic from upload.py"""
    # 1. Create dataset entry
    # 2. Rename file, create ortho entry
    # 3. Update status is_upload_done=True
    # 4. Frontend calls /process endpoint separately

# api/src/upload/raw_images_processor.py  
async def process_raw_images_upload(...) -> Dataset:
    """New ZIP processing - file handling only"""
    # 1. Create dataset entry
    # 2. Extract ZIP, validate images, transfer to storage
    # 3. Create raw_images entry
    # 4. Update status is_upload_done=True
    # 5. Return dataset (NO task queueing here)
```

### **3. Configurable Process Endpoint**
```python
# api/src/routers/process.py (or equivalent)

class ProcessRequest(BaseModel):
    task_types: List[TaskTypeEnum]

@router.post('/datasets/{dataset_id}/process') # ENHANCED
async def queue_processing_tasks(
    dataset_id: int,
    process_request: ProcessRequest,
    # ... existing dependencies
):
    """Queues tasks for a dataset based on a list provided by the client."""
    # 1. Validate dataset exists
    # 2. Create TaskPayload using process_request.task_types
    # 3. Insert into queue table
    # 4. Return success
```

### **4. ODM Processing Function with Docker-in-Docker**
```python
# processor/src/process_odm.py
def process_odm(task: QueueTask, temp_dir: Path):
    """Execute ODM container using Docker-in-Docker"""
    import docker
    
    # 1. Pull raw images from storage server (SSH)
    # 2. Setup ODM container with volume mounts and GPU access
    client = docker.from_env()
    container = client.containers.run(
        image="opendronemap/odm",
        command=["--fast-orthophoto", "--project-path", "/project", str(dataset_id)],
        volumes={str(project_dir): {"bind": "/project", "mode": "rw"}},
        device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
        detach=True,
        remove=True
    )
    # 3. Wait for completion and handle results
    # 4. Push generated orthomosaic to storage server
    # 5. Create ortho entry (original, before standardization)
    # 6. Update status (is_odm_done=True)

# processor/src/processor.py modifications
# ADD odm_processing to the existing fail-fast chain
def process_task(task: QueueTask, token: str):
    # Process tasks in strict order with fail-fast behavior
    try:
        # Add ODM processing as the FIRST step in the chain
        if TaskTypeEnum.odm_processing in task.task_types:
            try:
                process_odm(task, settings.processing_path)
            except Exception as e:
                raise ProcessingError(str(e), task_type='odm_processing', ...)

        # Existing GeoTIFF processing is next
        if TaskTypeEnum.geotiff in task.task_types:
            process_geotiff(task, settings.processing_path)  # Existing function
        
        # ... other tasks follow in the existing fail-fast chain
```

### **5. Comprehensive EXIF Extraction**
```python
# api/src/upload/exif_utils.py
def extract_comprehensive_exif(image_path: Path) -> Dict[str, Any]:
    """Extract comprehensive EXIF data for camera metadata"""
    from PIL import Image
    from PIL.ExifTags import TAGS, GPSTAGS
    
    try:
        with Image.open(image_path) as img:
            exif = img._getexif()
            if not exif:
                return {}
                
            metadata = {}
            
            # Basic camera info
            metadata['camera_make'] = exif.get('Make')
            metadata['camera_model'] = exif.get('Model')
            metadata['camera_serial'] = exif.get('SerialNumber')
            
            # Image settings
            metadata['iso'] = exif.get('ISOSpeedRatings')
            metadata['aperture'] = exif.get('FNumber')
            metadata['shutter_speed'] = exif.get('ExposureTime')
            metadata['focal_length'] = exif.get('FocalLength')
            
            # Image dimensions
            metadata['width'] = exif.get('ExifImageWidth')
            metadata['height'] = exif.get('ExifImageHeight')
            
            # GPS data
            gps_info = exif.get('GPSInfo')
            if gps_info:
                metadata['gps'] = extract_gps_coordinates(gps_info)
                metadata['altitude'] = gps_info.get('GPSAltitude')
                
            # Datetime
            datetime_str = exif.get('DateTimeOriginal')
            if datetime_str:
                metadata['acquisition_datetime'] = datetime.strptime(datetime_str, '%Y:%m:%d %H:%M:%S')
                
            return metadata
            
    except Exception as e:
        logger.warning(f"EXIF extraction failed for {image_path}: {str(e)}")
        return {}

def extract_acquisition_date(image_path: Path) -> Optional[datetime]:
    """Extract acquisition date for v2_datasets fields"""
    metadata = extract_comprehensive_exif(image_path)
    return metadata.get('acquisition_datetime')
```

---

## 📁 **STORAGE ARCHITECTURE**

```
Storage Server:
├── archive/
│   └── {dataset_id}_ortho.tif     # Final orthomosaics (both workflows)
└── raw_images/
    └── {dataset_id}/
        └── images/
            ├── DJI_001.JPG        # ZIP uploads - drone images
            ├── DJI_002.JPG        
            ├── DJI_timestamp.MRK  # RTK timestamp data
            ├── DJI_rtk.RTK        # RTK positioning data
            ├── DJI_rtk.RTL        # RTK auxiliary files
            └── ...                # All ZIP contents together

Processing Server (temporary):
└── processing_dir/
    └── odm_{dataset_id}/
        ├── images/                # Pulled from storage (all files)
        │   ├── DJI_001.JPG        # Images for ODM processing
        │   ├── DJI_timestamp.MRK  # RTK data available to ODM
        │   └── ...
        └── {dataset_id}/
            └── odm_orthophoto/
                └── odm_orthophoto.tif
```

---

## 🐳 **DOCKER CONFIGURATION**

### **ODM Container Execution**
```python
# ODM command
container = client.containers.run(
    image="opendronemap/odm",
    command=["--fast-orthophoto", "--project-path", "/project", str(dataset_id)],
    volumes={str(project_dir): {"bind": "/project", "mode": "rw"}},
    device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
    detach=True,
    remove=True
)
```

### **Processor Container Requirements**
- Mount `/var/run/docker.sock` for Docker-in-Docker
- GPU access for ODM containers
- SSH keys for storage server access

### **Required Docker Compose Changes**
```yaml
# docker-compose.processor.yaml - ADD:
volumes:
  - /var/run/docker.sock:/var/run/docker.sock  # Enable Docker-in-Docker
```

---

## 🧪 **TESTING STRATEGY**

### **Test-Driven Development Approach**
Following established codebase patterns for integration-focused testing with real data:

**Core Principle**: Focus on critical path testing with real drone images, not exhaustive unit testing.

### **Critical Test Coverage**

#### **1. ZIP Upload & Extraction Test**
```python
# api/tests/routers/test_upload_odm.py
def test_zip_upload_and_extraction(test_raw_images_zip, auth_token, test_user):
    """Test ZIP upload creates dataset and raw_images entries"""
    # Follow existing chunked upload pattern
    # Verify v2_datasets entry created
    # Verify v2_raw_images entry with correct metadata
    # Verify images transferred to storage server
```

#### **2. ODM Container Integration Test**
```python
# processor/tests/test_process_odm.py
def test_odm_docker_execution(test_dataset_with_raw_images, auth_token):
    """Test ODM container execution with real images"""
    # Use existing test_dataset_for_processing pattern
    # Test Docker container execution
    # Verify orthomosaic generation
    # Verify status tracking (is_odm_done=True)
```

#### **3. Complete Pipeline Test**
```python
# processor/tests/test_odm_pipeline.py  
def test_complete_odm_pipeline(test_raw_images_zip, auth_token):
    """Test full ZIP → ODM → GeoTIFF → COG → Thumbnail workflow"""
    # Follow comprehensive testing pattern from test_process_cog.py
    # Process all task types: ['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']
    # Verify database entries in all tables
    # Verify final status: all is_*_done flags = True
```

### **Test Data & Fixtures**

#### **Real Drone Images**
**Available Data**: 277 DJI drone images from `DJI_202504031231_008_hartheimwithbuffer60m/` (~2.6GB total)

**Test Subsets to Create**:
```
assets/test_data/raw_drone_images/
├── test_minimal_3_images.zip         # Images 0001-0003 (minimal valid ODM set)
├── test_small_10_images.zip          # Images 0001-0010 (fast development testing)
├── test_medium_25_images.zip         # Images 0001-0025 (comprehensive testing)
└── test_invalid_2_images.zip         # Images 0001-0002 (error testing - insufficient)
```

**Creation Script**:
```bash
# Run the provided script to create all test ZIP files from the 277 available DJI images
./scripts/create_odm_test_data.sh

# This creates:
# - test_minimal_3_images.zip: 3 images (~30MB) - fastest testing
# - test_small_10_images.zip: 10 images (~100MB) - development testing  
# - test_medium_25_images.zip: 25 images (~250MB) - comprehensive testing
# - test_invalid_2_images.zip: 2 images (~20MB) - error testing
```

#### **Test Fixtures**
```python
@pytest.fixture
def test_raw_images_zip_minimal():
    """Provide minimal ZIP file (3 images ~30MB) for fast testing"""
    zip_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_3_images.zip'
    if not zip_path.exists():
        pytest.skip('Minimal drone images ZIP not found - run creation script')
    return zip_path

@pytest.fixture
def test_raw_images_zip_small():
    """Provide small ZIP file (10 images ~100MB) for development testing"""
    zip_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'raw_drone_images' / 'test_small_10_images.zip'
    if not zip_path.exists():
        pytest.skip('Small drone images ZIP not found - run creation script')
    return zip_path

@pytest.fixture
def test_raw_images_zip_invalid():
    """Provide invalid ZIP file (2 images) for error testing"""
    zip_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'raw_drone_images' / 'test_invalid_2_images.zip'
    if not zip_path.exists():
        pytest.skip('Invalid drone images ZIP not found - run creation script')
    return zip_path

@pytest.fixture  
def test_dataset_with_raw_images(auth_token, test_raw_images_zip_minimal, test_processor_user):
    """Create dataset with raw images entry (follows existing pattern)"""
    # Extract ZIP and store in test location
    # Create v2_datasets entry (with acquisition date: 2025-04-03)
    # Create v2_raw_images entry (3 images, ~30MB)
    # Transfer images to storage server: raw_images/{dataset_id}/images/
    # Yield dataset_id
    # Cleanup in finally block
```

### **Error Testing Strategy**

#### **Critical Failure Points**
```python
def test_odm_container_failure(test_dataset_with_insufficient_images):
    """Test ODM failure with insufficient overlap"""
    # Verify error handling
    # Verify cleanup occurs
    # Verify status: has_error=True, error_message populated

def test_docker_socket_unavailable():
    """Test graceful handling when Docker socket not accessible"""
    # Mock Docker client failure
    # Verify error propagation
    # Verify no orphaned containers
```

### **Performance & Resource Testing**

#### **Resource Management**
```python
@pytest.mark.slow
def test_odm_resource_limits():
    """Test ODM with large image sets"""
    # Use larger test ZIP (10+ images)
    # Monitor memory usage
    # Verify cleanup after completion
    # Verify no resource leaks
```

### **Test Execution Strategy**

#### **Development Testing**
```bash
# Quick critical path tests
deadtrees dev test api --test-path=api/tests/routers/test_upload_odm.py::test_zip_upload_basic

# ODM integration tests
deadtrees dev test processor --test-path=processor/tests/test_process_odm.py::test_odm_execution

# Complete pipeline test
deadtrees dev test processor --test-path=processor/tests/test_odm_pipeline.py::test_complete_pipeline
```

#### **Comprehensive Testing**
```bash
# Full ODM test suite (marked as comprehensive)
pytest -m "odm and comprehensive" processor/tests/

# All tests including slow ODM tests  
pytest -m "" processor/tests/test_*odm*.py
```

### **Test Markers & Organization**
```python
# Test markers following existing patterns
@pytest.mark.odm                    # ODM-specific tests
@pytest.mark.slow                   # Long-running tests
@pytest.mark.comprehensive          # Complete pipeline tests
@pytest.mark.docker                 # Requires Docker functionality
```

---

## 📋 **DEPENDENCIES**

### **New Package Requirements**
```txt
# processor/requirements.txt
docker>=6.1.0

# api/requirements.txt  
Pillow>=10.0.0
```

### **Infrastructure Requirements**
- OpenDroneMap Docker image with GPU support
- NVIDIA Container Toolkit on processing server
- Docker socket access for processor container
- Additional storage capacity for raw images
- SSH connectivity between processing and storage servers

---

## ⚠️ **CRITICAL CONSIDERATIONS**

### **Security**
- Docker socket mounting requires security review
- Raw image file validation (prevent malicious uploads)
- Resource limits for ODM containers

### **Performance**  
- Sequential ODM processing (one container at a time)
- 24-hour timeout for ODM processing
- Storage growth monitoring for raw images

### **Error Handling**
- ODM container failures → mark task as failed
- SSH connection failures → retry mechanism
- Invalid ZIP files → clear user error messages
- Insufficient images (< 3) → validation error

---

**Implementation Status**: Ready to begin Phase 1  
**Next Step**: Create v2_raw_images table migration 