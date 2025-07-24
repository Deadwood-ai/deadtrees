# ODM Raw Drone Image Processing - Technical Design

**Version:** 2.1  
**Date:** December 2024  
**Status:** ✅ Ready for Implementation - Processor-Centric Architecture

---

## 🏗️ **ARCHITECTURE OVERVIEW**

### **Core Decisions**
- **Processor-Centric**: ALL technical analysis and ortho creation happens in processor
- **Simplified Upload**: Upload endpoints focus only on file storage
- **Unified Processing**: Both GeoTIFF and ZIP paths converge at ortho creation
- **No Code Duplication**: Single technical analysis logic in processor

### **Processing Flows (Processor-Centric)**
```
GeoTIFF: Upload (store only) → [geotiff→cog→thumb→metadata→deadwood]
ZIP:     Upload (extract only) → [odm→geotiff→cog→thumb→metadata→deadwood]

Both paths converge at geotiff processing where ortho entries are created
```

### **Key Architectural Changes**
- **Upload**: No `cog_info()`, no `get_file_identifier()`, no `upsert_ortho_entry()`
- **Processor**: Enhanced `geotiff` processing handles ortho creation for both sources
- **Consistency**: Identical technical analysis logic regardless of orthomosaic origin

---

## 🗄️ **DATABASE SCHEMA**

### **Separate v2_raw_images Table - Following Established Patterns**
Clean separation following existing v2_* table architecture:

```sql
-- New table for raw drone image metadata with comprehensive EXIF storage
CREATE TABLE "public"."v2_raw_images" (
    "dataset_id" bigint NOT NULL REFERENCES "public"."v2_datasets"(id) ON DELETE CASCADE,
    "raw_image_count" integer NOT NULL,
    "raw_image_size_mb" integer NOT NULL, 
    "raw_images_path" text NOT NULL, -- Contains both images and RTK files
    "camera_metadata" jsonb, -- Comprehensive EXIF metadata in structured format
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

-- GIN index for efficient JSONB querying of camera metadata
CREATE INDEX v2_raw_images_camera_metadata_gin_idx ON public.v2_raw_images USING gin (camera_metadata);

-- Example camera_metadata structure (populated during ODM processing):
-- {
--   "Make": "DJI",
--   "Model": "FC6310",
--   "Software": "v01.00.0300",
--   "DateTime": "2024:01:15 14:30:45",
--   "DateTimeOriginal": "2024:01:15 14:30:45",
--   "ExifImageWidth": 5472,
--   "ExifImageHeight": 3648,
--   "ISO": 100,
--   "FNumber": 2.8,
--   "ExposureTime": "1/1000",
--   "FocalLength": 8.8,
--   "WhiteBalance": "Auto",
--   "ColorSpace": "sRGB",
--   "GPSLatitude": 48.1234,
--   "GPSLongitude": 11.5678,
--   "GPSAltitude": 120.5
-- }
```

### **Status System Integration - Following Existing Patterns**
Extend v2_statuses table using established patterns:

```sql
-- Add ODM processing status to enum (matches existing pattern)
ALTER TYPE "public"."v2_status" ADD VALUE 'odm_processing';

-- Add ODM completion flag (matches is_*_done pattern)  
ALTER TABLE "public"."v2_statuses" ADD COLUMN "is_odm_done" boolean NOT NULL DEFAULT false;
```

**Ortho Table Population (Critical Change):**
- **Upload Phase**: NO ortho entries created (GeoTIFF or ZIP)
- **Processing Phase**: ALL ortho entries created during `geotiff` processing task
- **Unified Logic**: Single `upsert_ortho_entry()` call location in processor

**Storage Path Convention:**
- GeoTIFF uploads: `archive/{dataset_id}_ortho.tif` (no ortho entry until processing)
- ZIP uploads: `raw_images/{dataset_id}/` (extracted contents) 
- ODM output: `archive/{dataset_id}_ortho.tif` (moved from ODM temp location)
- Processing: Creates ortho entries for files found in `archive/` directory

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

### **1. Simplified Upload Endpoints**
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

@router.post('/datasets/chunk')
async def upload_chunk(
    # ... existing parameters ...
    upload_type: Annotated[Optional[UploadType], Form()] = None,
):
    # ... existing chunk logic ...
    
    # Final chunk processing - SIMPLIFIED (no technical analysis)
    if chunk_index == chunks_total - 1:
        detected_type = upload_type or detect_upload_type(upload_target_path)
        
        dataset = create_dataset_entry(...)  # Same for both types
        
        if detected_type == UploadType.GEOTIFF:
            # Store file only - NO ortho entry creation
            target_path = settings.archive_path / f"{dataset.id}_ortho.tif"
            upload_target_path.rename(target_path)
            
        elif detected_type == UploadType.RAW_IMAGES_ZIP:
            # Extract and store - NO technical analysis
            extract_zip_to_raw_images(dataset.id, upload_target_path)
            create_raw_images_entry(dataset.id, ...)
        
        update_status(token, dataset.id, is_upload_done=True)
        return dataset
```

### **2. Enhanced Processor Components**

#### **Unified GeoTIFF Processing (Key Component)**
```python
# processor/src/process_geotiff.py - NOW handles ortho creation for both sources
def process_geotiff(task: QueueTask, temp_dir: Path):
    """Enhanced to handle ortho creation for both direct upload and ODM-generated files"""
    
    # 1. Find orthomosaic file (could be direct upload or ODM output)
    ortho_file_path = settings.archive_path / f"{task.dataset_id}_ortho.tif"
    
    if not ortho_file_path.exists():
        raise ProcessingError(f"No orthomosaic found for dataset {task.dataset_id}")
    
    # 2. Create ortho entry (moved from upload logic)
    sha256 = get_file_identifier(ortho_file_path)
    ortho_info = cog_info(ortho_file_path)
    
    upsert_ortho_entry(
        dataset_id=task.dataset_id,
        file_path=ortho_file_path,
        version=1,
        sha256=sha256,
        ortho_info=ortho_info,
        ortho_upload_runtime=0.0,  # Set during upload in old flow, now N/A
        token=token,
    )
    
    # 3. Continue with standardization (existing logic)
    standardise_geotiff(str(ortho_file_path), str(processed_path), token, task.dataset_id)
    
    # 4. Create processed ortho entry (existing logic)
    upsert_processed_ortho_entry(...)
    
    update_status(token, task.dataset_id, is_ortho_done=True)
```

#### **Enhanced ODM Processing with EXIF Extraction**
```python
# processor/src/process_odm.py
def process_odm(task: QueueTask, temp_dir: Path):
    """Generate ODM orthomosaic with comprehensive EXIF metadata extraction"""
    
    # 1. Pull raw images from storage
    raw_images_dir = temp_dir / f"raw_images_{task.dataset_id}"
    pull_raw_images_from_storage(task.dataset_id, raw_images_dir)
    
    # 2. Extract ZIP file locally for processing
    extraction_dir = temp_dir / f'raw_images_{task.dataset_id}'
    extract_zip_locally(task.dataset_id, extraction_dir)
    
    # 2.5. Extract comprehensive EXIF metadata - NEW STEP
    extract_and_store_exif_metadata(extraction_dir, task.dataset_id, token)
    
    # 3. Execute ODM container
    odm_output_dir = temp_dir / f"odm_{task.dataset_id}"
    execute_odm_container(extraction_dir, odm_output_dir, task.dataset_id)
    
    # 4. Move generated orthomosaic to standard archive location
    odm_ortho = odm_output_dir / task.dataset_id / "odm_orthophoto" / "odm_orthophoto.tif"
    final_ortho = settings.archive_path / f"{task.dataset_id}_ortho.tif"
    
    shutil.move(str(odm_ortho), str(final_ortho))
    
    # 5. Update status only - NO ortho entry creation (geotiff processor will handle)
    update_status(token, task.dataset_id, is_odm_done=True)
    
    # NOTE: geotiff processing task will find the file and create ortho entry

def extract_and_store_exif_metadata(extraction_dir: Path, dataset_id: int, token: str):
    """Extract comprehensive EXIF metadata and store in v2_raw_images.camera_metadata"""
    from api.src.upload.exif_utils import extract_comprehensive_exif
    
    # Find image files
    image_files = list(extraction_dir.glob('*.jpg')) + list(extraction_dir.glob('*.JPG'))
    image_files += list(extraction_dir.glob('*.jpeg')) + list(extraction_dir.glob('*.JPEG'))
    
    # Sample first 3 images to find representative EXIF data
    camera_metadata = {}
    for image_file in image_files[:3]:
        exif_data = extract_comprehensive_exif(image_file)
        if exif_data:
            camera_metadata = exif_data
            break
    
    # Update v2_raw_images with comprehensive EXIF metadata
    if camera_metadata:
        with use_client(token) as client:
            client.table(settings.raw_images_table)\
                  .update({'camera_metadata': camera_metadata})\
                  .eq('dataset_id', dataset_id)\
                  .execute()
```

### **3. Upload Processing Functions - Simplified Architecture**
```python
# api/src/upload/geotiff_processor.py - SIMPLIFIED
async def process_geotiff_upload(dataset: Dataset, upload_target_path: Path) -> Dataset:
    """Simplified GeoTIFF upload - file storage only"""
    # 1. Move to standard location - NO technical analysis
    final_path = settings.archive_path / f"{dataset.id}_ortho.tif"
    upload_target_path.rename(final_path)
    
    # 2. Update status - NO ortho entry creation
    update_status(token, dataset.id, is_upload_done=True)
    
    return dataset

# api/src/upload/raw_images_processor.py - SIMPLIFIED  
async def process_raw_images_upload(dataset: Dataset, upload_target_path: Path) -> Dataset:
    """Simplified ZIP upload - extraction and storage only"""
    # 1. Extract ZIP - NO technical analysis during extraction
    raw_images_dir = settings.raw_images_path / str(dataset.id)
    extract_zip_safely(upload_target_path, raw_images_dir)
    
    # 2. Create raw_images entry - basic metadata only
    create_raw_images_entry(dataset.id, raw_images_dir)
    
    # 3. Update status - NO technical analysis
    update_status(token, dataset.id, is_upload_done=True)
    
    return dataset
```

### **4. Task Execution Requirements**
```python
# processor/src/processor.py - Updated execution order
def process_task(task: QueueTask, token: str):
    """Process tasks with unified ortho creation"""
    
    # 1. ODM processing (if ZIP upload)
    if TaskTypeEnum.odm_processing in task.task_types:
        process_odm(task, temp_dir)
    
    # 2. GeoTIFF processing (ALWAYS - creates ortho entry for both sources)
    if TaskTypeEnum.geotiff in task.task_types:  # Required for both upload types
        process_geotiff(task, temp_dir)  # NOW handles ortho creation
    
    # 3. Rest of pipeline continues identically
    if TaskTypeEnum.cog in task.task_types:
        process_cog(task, temp_dir)
    
    # ... other tasks unchanged
```

### **5. Queue Management Requirements**
```python
# Frontend must ensure geotiff processing included for ALL uploads:

# GeoTIFF upload task list:
task_types = ['geotiff', 'cog', 'thumbnail', 'metadata']

# ZIP upload task list:  
task_types = ['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']

# Both include 'geotiff' - ensures ortho entry creation
```

---

## 📁 **STORAGE ARCHITECTURE**

### **Simplified Upload Storage**
```
Upload Results (No Technical Analysis):
├── archive/
│   └── {dataset_id}_ortho.tif         # GeoTIFF uploads (no ortho entry yet)
└── raw_images/
    └── {dataset_id}/
        ├── {dataset_id}_raw_images.zip # Original ZIP file (preserved)
        └── images/
            ├── DJI_001.JPG            # Extracted drone images
            ├── DJI_002.JPG        
            ├── DJI_timestamp.MRK      # RTK timestamp data
            └── ...                    # All extracted ZIP contents
```

### **Processing Storage (Where Technical Analysis Happens)**
```
Processing Server:
├── temp_dir/
│   ├── raw_images_{dataset_id}/       # Pulled from storage for ODM
│   ├── odm_{dataset_id}/             # ODM working directory
│   └── processed_files/              # Standardization output
└── Archive Updates:
    └── archive/
        └── {dataset_id}_ortho.tif   # ODM moves output here, GeoTIFF already here

Final Result After Processing:
├── v2_datasets (unchanged)
├── v2_raw_images (ZIP uploads only)
└── v2_orthos (created during geotiff processing for BOTH sources)
```

---

## 🐳 **DOCKER CONFIGURATION**

### **ODM Container Execution**
```python
# ODM command remains the same
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
- SSH keys for storage server access (during processing only)

---

## 🧪 **TESTING STRATEGY**

### **Test-Driven Development Approach**
Following established codebase patterns for integration-focused testing with real data:

**Core Principle**: Focus on critical path testing with real drone images, emphasizing the new unified processing flow.

### **Critical Test Coverage**

#### **1. Simplified Upload Tests**
```python
# api/tests/routers/test_upload_simplified.py
def test_geotiff_upload_no_ortho_creation(test_geotiff_file, auth_token, test_user):
    """Test GeoTIFF upload creates dataset but NO ortho entry"""
    dataset = upload_geotiff_chunked(test_geotiff_file, auth_token)
    
    # Verify dataset created
    assert dataset is not None
    
    # Verify file stored in archive
    ortho_file = settings.archive_path / f"{dataset.id}_ortho.tif"
    assert ortho_file.exists()
    
    # Verify NO ortho entry created (key change)
    with use_client(auth_token) as client:
        response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset.id).execute()
        assert len(response.data) == 0  # No ortho entry during upload

def test_zip_upload_no_technical_analysis(test_raw_images_zip, auth_token, test_user):
    """Test ZIP upload creates dataset and raw_images entry only"""
    dataset = upload_zip_chunked(test_raw_images_zip, auth_token)
    
    # Verify dataset created
    assert dataset is not None
    
    # Verify raw_images entry created
    with use_client(auth_token) as client:
        response = client.table('v2_raw_images').select('*').eq('dataset_id', dataset.id).execute()
        assert len(response.data) == 1
        
    # Verify NO ortho entry created (key change)
    with use_client(auth_token) as client:
        response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset.id).execute()
        assert len(response.data) == 0  # No ortho entry during upload
```

#### **2. Unified Processor Tests**
```python
# processor/tests/test_unified_geotiff_processing.py
def test_geotiff_processing_creates_ortho_entry(test_dataset_geotiff_upload, auth_token):
    """Test geotiff processing creates ortho entry for direct upload"""
    # Setup: Dataset exists with file in archive/, no ortho entry
    task = create_task(['geotiff'], test_dataset_geotiff_upload)
    
    # Execute geotiff processing
    process_geotiff(task, temp_dir)
    
    # Verify ortho entry created
    with use_client(auth_token) as client:
        response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
        assert len(response.data) == 1
        ortho = response.data[0]
        assert ortho['sha256'] is not None
        assert ortho['ortho_info'] is not None

def test_geotiff_processing_after_odm(test_dataset_with_odm_output, auth_token):
    """Test geotiff processing creates ortho entry for ODM-generated file"""
    # Setup: ODM has moved file to archive/, no ortho entry yet
    task = create_task(['geotiff'], test_dataset_with_odm_output)
    
    # Execute geotiff processing
    process_geotiff(task, temp_dir)
    
    # Verify ortho entry created (same logic as direct upload)
    with use_client(auth_token) as client:
        response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
        assert len(response.data) == 1
        # Same verification as direct upload test
```

#### **3. Complete Pipeline Tests**
```python
# processor/tests/test_complete_pipeline.py  
def test_complete_geotiff_pipeline(test_geotiff_upload, auth_token):
    """Test complete pipeline starting from uploaded GeoTIFF"""
    task = create_task(['geotiff', 'cog', 'thumbnail', 'metadata'], test_geotiff_upload)
    
    process_task(task, auth_token)
    
    # Verify all database entries created
    verify_complete_pipeline_state(task.dataset_id, auth_token)

def test_complete_odm_pipeline(test_zip_upload, auth_token):
    """Test complete pipeline starting from ZIP upload"""
    task = create_task(['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata'], test_zip_upload)
    
    process_task(task, auth_token)
    
    # Verify identical end state as GeoTIFF pipeline
    verify_complete_pipeline_state(task.dataset_id, auth_token)
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

#### **Test Fixtures (Updated for New Architecture)**
```python
@pytest.fixture
def test_geotiff_upload_no_ortho():
    """Dataset with GeoTIFF uploaded but no ortho entry (new behavior)"""
    # Create dataset entry and store file in archive/
    # Do NOT create ortho entry (simulates new upload behavior)
    return dataset_id

@pytest.fixture
def test_odm_output_ready():
    """Dataset with ODM output moved to archive, ready for geotiff processing"""
    # Create raw_images entry and place ODM output in archive/
    # Do NOT create ortho entry (simulates ODM completion)
    return dataset_id
```

---

## 📋 **DEPENDENCIES**

### **New Package Requirements**
```txt
# processor/requirements.txt
docker>=6.1.0

# api/requirements.txt  
Pillow>=10.0.0  # Only if EXIF processing kept in backend
```

### **Infrastructure Requirements**
- OpenDroneMap Docker image with GPU support
- NVIDIA Container Toolkit on processing server
- Docker socket access for processor container
- Simplified upload processing (faster, more reliable)

---

## ⚠️ **CRITICAL CONSIDERATIONS**

### **Database State Consistency**
- **Critical**: Both upload types must result in identical database state after geotiff processing
- **Verification**: Same ortho table structure regardless of source
- **Testing**: Comprehensive validation of unified processing paths

### **Task Queue Requirements**  
- **Frontend responsibility**: Must include 'geotiff' in task list for ALL uploads
- **Processor validation**: Ensure geotiff processing always executes before other tasks
- **Error handling**: Clear messaging if geotiff task missing from queue

### **Performance Benefits**
- **Upload speed**: Faster uploads due to eliminated technical analysis
- **Reliability**: Fewer upload failure points
- **Consistency**: Identical processing behavior regardless of source
- **Maintainability**: Single technical analysis code path

---

**Implementation Status**: Ready to begin Phase 1  
**Architecture Benefits**: Simplified upload, unified processing, eliminated code duplication  
**Next Step**: Update implementation.md with revised task breakdown 