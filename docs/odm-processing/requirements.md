# ODM Raw Drone Image Processing - Requirements Document

**Version:** 2.0  
**Date:** December 2024  
**Project:** DeadTrees Platform - OpenDroneMap Integration  
**Status:** ✅ UPDATED - Unified Upload Approach

---

## 📋 **OVERVIEW**

Backend integration of OpenDroneMap (ODM) for processing raw drone images into orthomosaics within the existing DeadTrees processing pipeline using a **unified chunked upload endpoint**.

### **System Boundary**
- **Frontend**: Enhanced upload interface supporting both GeoTIFF and ZIP files
- **Backend API**: Enhanced existing chunked upload endpoint with smart file type routing
- **Processing Server**: ODM Docker container execution with GPU acceleration
- **Storage Server**: Raw image storage and file transfer via SSH
- **Database**: Extended queue system and raw image metadata tracking

### **Unified Processing Flow**
1. **Upload**: Users upload GeoTIFF or ZIP via same chunked upload interface
2. **Detection**: Backend automatically detects file type (.tif or .zip)
3. **Routing**: Smart routing to appropriate processing logic
4. **Processing**: 
   - **GeoTIFF**: Direct ortho creation → standard pipeline
   - **ZIP**: Extract → validate → store → ODM → standard pipeline
5. **Pipeline**: Both paths converge at standard processing (COG → Thumbnail → Metadata → Segmentation)

---

## 🎯 **USER STORIES (EARS Format)**

**US-ODM-001: Raw Image Upload**
- **Given** a user has raw drone images from a flight in ZIP format
- **When** the user uploads the ZIP archive via chunked upload
- **Then** the system shall extract and store images on storage server
- **And** the system shall validate image formats (JPEG/JPG/TIF)
- **And** the system shall extract acquisition date from EXIF data automatically
- **And** the system shall create dataset and raw image database entries
- **Response** within 60 seconds for ZIP processing and validation

**US-ODM-002: ODM Processing Integration**
- **Given** raw images are stored and validated
- **When** an ODM processing task is queued via the process endpoint
- **Then** the system shall fetch images from storage server to processing server
- **And** the system shall execute ODM Docker container with GPU acceleration
- **And** the system shall generate georeferenced orthomosaic in GeoTIFF format
- **And** the system shall push orthomosaic back to storage server
- **And** the system shall apply GeoTIFF standardization for quality assurance
- **And** the system shall queue remaining processing tasks (COG, thumbnail, metadata)
- **Response** processing time varies (1-24 hours depending on image count and complexity)

**US-ODM-003: Legacy Workflow Preservation**
- **Given** a user has pre-processed orthomosaic
- **When** using existing direct orthomosaic upload workflow
- **Then** the system shall continue supporting direct orthomosaic upload unchanged
- **And** the system shall bypass ODM processing for direct uploads
- **And** the system shall process via existing GeoTIFF → COG → Thumbnail pipeline
- **And** the system shall maintain identical performance and behavior
- **Response** same performance as current workflow

**US-ODM-004: Acquisition Date Automation**
- **Given** raw drone images contain EXIF metadata
- **When** images are uploaded and processed
- **Then** the system shall automatically extract acquisition date from EXIF DateTimeOriginal
- **And** the system shall populate dataset acquisition_year, acquisition_month, acquisition_day
- **And** the system shall handle missing or invalid EXIF data gracefully
- **Response** metadata extraction within 10 seconds per image during upload

**US-ODM-005: RTK High-Precision Processing**
- **Given** a ZIP file contains RTK positioning data files (.RTK, .MRK, .RTL, .RTB, .RPOS)
- **When** the ZIP is uploaded and processed
- **Then** the system shall automatically detect RTK data presence
- **And** the system shall extract RTK precision indicators from timestamp files (.MRK)
- **And** the system shall transfer RTK files to storage server alongside images
- **And** the system shall execute ODM with high-precision GPS flags (--force-gps, --gps-accuracy)
- **And** the system shall achieve centimeter-level absolute positioning accuracy
- **Response** RTK detection and parameter extraction within 5 seconds during upload

---

## 🗄️ **DATABASE SCHEMA CHANGES**

### **Separate v2_raw_images Table - Clean Architecture**
Keep v2_datasets focused on final processed data, create separate table for raw input material:

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

-- Add index and primary key
CREATE UNIQUE INDEX v2_raw_images_pkey ON public.v2_raw_images USING btree (dataset_id);
ALTER TABLE "public"."v2_raw_images" ADD CONSTRAINT "v2_raw_images_pkey" PRIMARY KEY using index "v2_raw_images_pkey";
```

### **Status Table Extensions - Following Existing Patterns**
Extend existing v2_statuses table with ODM processing flags:

```sql
-- Add ODM processing to status enum (follows existing pattern)
ALTER TYPE "public"."v2_status" ADD VALUE 'odm_processing';

-- Add ODM completion flag (follows existing is_*_done pattern)
ALTER TABLE "public"."v2_statuses" ADD COLUMN "is_odm_done" boolean NOT NULL DEFAULT false;
```

### **Status System Benefits**
- **Consistent tracking**: Uses established v2_statuses pattern
- **Unified error handling**: Leverages existing has_error/error_message fields
- **Queue integration**: Works with existing task execution order
- **Clean separation**: Raw image metadata separate from status tracking

### **Frontend EXIF Extraction Strategy**
- Extract acquisition date **in frontend** during ZIP selection/preview
- Populate v2_datasets.aquisition_* fields directly via upload API
- Store comprehensive camera metadata in v2_raw_images.camera_metadata
- **Benefits**: Immediate validation, lighter server load, better UX

### **Enum Extensions**
```python
# shared/models.py - CURRENT TaskTypeEnum:
class TaskTypeEnum(str, Enum):
    cog = 'cog'                        # Existing
    deadwood = 'deadwood'              # Existing  
    geotiff = 'geotiff'                # Existing - will standardize ODM outputs
    metadata = 'metadata'              # Existing
    odm_processing = 'odm_processing'  # NEW - Always first in execution
    thumbnail = 'thumbnail'            # Existing

# shared/models.py - CURRENT StatusEnum with addition:
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

# Add RawImages Pydantic model
class RawImages(BaseModel):
    id: Optional[int] = None
    dataset_id: int
    raw_image_count: int
    raw_image_size_mb: int
    raw_images_path: str
    camera_metadata: Optional[Dict[str, Any]] = None
    version: int = 1
    created_at: Optional[datetime] = None

# Extend Status model
class Status(BaseModel):
    # ... existing fields ...
    is_odm_done: bool = False  # NEW
```

### **Clean Separation Benefits**
- **v2_datasets**: Final processed data only (user-facing)
- **v2_raw_images**: Input material metadata (processing-focused)  
- **Frontend EXIF**: Immediate acquisition date without server processing
- **Backwards Compatible**: No changes to existing v2_datasets table
- **Scalable**: Handles volume differences (more orthos than raw uploads)

---

## 🔧 **FUNCTIONAL REQUIREMENTS**

### **FR-ODM-001: ZIP Upload Support**
- System shall accept ZIP files via chunked upload (similar to existing upload mechanism)
- System shall support JPEG/JPG/TIF image formats
- System shall validate minimum 3 images for ODM processing
- System shall extract and store images on storage server using SSH transfer

### **FR-ODM-002: Enhanced EXIF Data Management**
- System shall extract comprehensive EXIF data from raw images during upload processing
- System shall capture camera make/model, GPS coordinates, flight altitude, image dimensions
- System shall store **comprehensive EXIF data** in **v2_raw_images.camera_metadata** JSONB field
- System shall populate **basic acquisition date** in existing **v2_datasets** fields (aquisition_year, aquisition_month, aquisition_day)
- System shall handle missing or corrupted EXIF data gracefully

### **FR-ODM-002A: RTK Data Detection and Processing**
- System shall automatically detect RTK positioning files in ZIP uploads (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
- System shall parse RTK timestamp files (.MRK) to extract precision indicators and quality metrics
- System shall extract RTK precision values (horizontal/vertical accuracy in centimeters)
- System shall extract RTK quality indicators (Q values: 50=excellent, 0-49=varying quality)
- System shall store RTK metadata in v2_raw_images table (has_rtk_data, rtk_precision_cm, rtk_quality_indicator)
- System shall transfer RTK auxiliary files to storage server alongside images

### **FR-ODM-003: ODM Container Integration** 
- System shall execute OpenDroneMap via GPU-accelerated Docker container using Docker-in-Docker
- System shall mount Docker socket for container execution within processor
- System shall use `--fast-orthophoto` processing mode for efficiency
- System shall handle ODM container lifecycle and resource management
- System shall use sequential processing (one ODM task at a time with full GPU access)
- System shall detect RTK data availability and adapt ODM command parameters accordingly
- System shall use `--force-gps` flag when RTK data is present to prioritize high-precision coordinates
- System shall set `--gps-accuracy` to centimeter values (0.01-0.05) based on detected RTK precision
- System shall transfer RTK auxiliary files to ODM project directory for potential processing use

### **FR-ODM-004: Storage Server Integration**
- System shall transfer raw images between storage and processing servers via SSH
- System shall use existing SSH utilities for file operations  
- System shall maintain unified directory structure: `raw_images/{dataset_id}/images/` containing both image and RTK files
- System shall preserve original ZIP file structure by storing RTK files alongside corresponding images
- System shall support chunked upload for large ZIP files containing images and RTK data
- System shall maintain permanent storage of raw images and RTK files (no automatic deletion)
- System shall preserve RTK file relationships and naming conventions for future reference

### **FR-ODM-005: Enhanced Queue System Integration**
- System shall add ODM processing to existing queue system with normal priority
- System shall **allow the frontend to queue ODM tasks via the /process endpoint** by providing a specific task list
- System shall execute tasks in strict order: ODM → GeoTIFF → COG → Thumbnail → Metadata → Deadwood
- System shall apply GeoTIFF standardization to ODM outputs for quality assurance
- System shall maintain fail-fast behavior: if any step fails, entire task fails
- System shall handle task failures with appropriate error recovery and cleanup

### **FR-ODM-006: Generated Orthomosaic Handling**
- System shall transfer generated orthomosaics to storage server
- System shall create ortho database entries for ODM-generated files
- System shall trigger standard processing pipeline automatically
- System shall handle acquisition date preservation from raw images to final dataset

---

## 🚨 **EDGE CASES & CONSTRAINTS**

### **EC-ODM-001: Invalid Image Sets**
- **Scenario**: Insufficient images or poor overlap for ODM processing
- **Handling**: ODM failure logged, task marked as failed, user notified via status

### **EC-ODM-002: Large File Handling**
- **Scenario**: ZIP archives approaching storage or processing limits
- **Handling**: Chunked upload support, progress tracking, timeout handling

### **EC-ODM-003: Storage Server Connectivity**
- **Scenario**: SSH connection failures during file transfer
- **Handling**: Retry mechanism, detailed error logging, task failure on persistent issues

### **EC-ODM-004: GPU Resource Availability**
- **Scenario**: GPU unavailable or insufficient memory
- **Handling**: Sequential ODM processing, task queuing until resources available

### **EC-ODM-005: Processing Failures**
- **Scenario**: ODM container fails during processing
- **Handling**: Mark task as failed, cleanup temporary files, detailed error logging

---

## 📋 **NON-FUNCTIONAL REQUIREMENTS**

### **Performance**
- ZIP upload: ≤ 2 minutes per GB via chunked upload
- ODM processing: Variable (1-24 hours depending on image count and complexity)
- File transfer: ≤ 5 minutes for 1GB between servers via SSH

### **Storage**
- Raw images: Permanent retention (no automatic deletion)
- Generated orthomosaics: Follow existing retention policies
- Storage server: Plan for significant growth in raw image storage requirements

### **Reliability**
- ODM success rate: ≥ 90% for valid image sets with proper overlap
- File transfer: ≥ 99% success rate with SSH retry mechanism
- Queue integration: No disruption to existing processing workflows

### **Scalability**
- Support up to 10 concurrent raw image uploads
- Sequential ODM processing (one container at a time with full GPU resources)
- Storage growth planning for raw image accumulation

---

## 🔄 **INTEGRATION POINTS**

### **Modified Components**
- **Upload API**: Enhanced existing chunked upload endpoint with smart file type routing
- **Processor**: Add ODM processing step before existing tasks
- **Queue System**: Ensure ODM tasks execute before other processing within same dataset
- **SSH Utilities**: Leverage existing file transfer capabilities for raw images
- **Status Tracking**: Extend for ODM processing states and raw image management

### **Unchanged Components**
- **Existing upload workflow**: Direct orthomosaic upload continues working
- **Processing pipeline**: COG, thumbnail, metadata, segmentation unchanged
- **Database structure**: Minimal extensions (new raw_images table only)
- **User interface**: Only upload method changes (add ZIP option for raw images)

### **New Components**
- **Raw Images Table**: Track metadata for uploaded raw image sets
- **ODM Processing Function**: Handle Docker container execution and file management
- **ZIP Processing Logic**: Extract, validate, and transfer raw images
- **Volume Mounting**: Enable ODM container access to image files

---

## ✅ **SUCCESS CRITERIA**

1. **Users can upload ZIP archive with 50+ drone images via chunked upload**
2. **ODM generates high-quality orthomosaic and enters existing processing pipeline**
3. **Acquisition date extracted automatically from EXIF data without user input**
4. **Processing queue handles ODM tasks with correct execution order**
5. **Raw images stored permanently on storage server for future reference**
6. **Existing direct orthomosaic upload continues working unchanged**
7. **GPU-accelerated processing provides reasonable performance for typical datasets**
8. **System handles processing failures gracefully with clear error messaging**

---

## 📝 **ASSUMPTIONS & DEPENDENCIES**

### **Assumptions**
- Raw drone images have GPS EXIF data for georeferencing
- ZIP archives contain images from single flight/project
- Users understand drone image capture requirements for successful ODM processing
- Existing storage server has capacity for raw image growth
- GPU hardware available on processing server for ODM acceleration

### **Dependencies**
- OpenDroneMap Docker image with GPU support
- NVIDIA Container Toolkit on processing server
- Docker socket access for processor container
- Additional storage capacity planning for raw images
- Existing SSH connectivity between processing and storage servers

---

**Document Status**: FINAL  
**Implementation Scope**: Backend integration only, minimal user interface changes  
**Technical Details**: See `design.md` for implementation see `implementation.md` specifications and database schemas  
**EXIF Data Strategy**: No separate EXIF table needed - capture only acquisition date in existing v2_raw_images and v2_datasets tables 