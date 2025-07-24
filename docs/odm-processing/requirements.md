# ODM Raw Drone Image Processing - Requirements Document

**Version:** 2.1  
**Date:** December 2024  
**Project:** DeadTrees Platform - OpenDroneMap Integration  
**Status:** ✅ UPDATED - Processor-Centric Architecture

---

## 📋 **OVERVIEW**

Backend integration of OpenDroneMap (ODM) for processing raw drone images into orthomosaics within the existing DeadTrees processing pipeline using a **processor-centric architecture** where all technical analysis and ortho table population occurs during processing, not upload.

### **System Boundary**
- **Frontend**: Enhanced upload interface supporting both GeoTIFF and ZIP files
- **Backend API**: Simplified upload endpoints focused on file storage only
- **Processing Server**: All technical analysis, ortho table creation, and standardization
- **Storage Server**: File storage and transfer via SSH during processing
- **Database**: Extended queue system and raw image metadata tracking

### **Unified Processing Flow (Processor-Centric)**
1. **Upload**: Users upload GeoTIFF or ZIP - files stored with minimal processing
   - **GeoTIFF**: Store in `archive/{dataset_id}_ortho.tif` - NO ortho entry creation
   - **ZIP**: Extract to `raw_images/{dataset_id}/` - create raw_images entry only
2. **Processing**: ALL technical analysis happens in processor
   - **GeoTIFF Path**: Process existing ortho → create ortho entry → standardize → pipeline
   - **ZIP Path**: ODM processing → generate ortho → create ortho entry → standardize → pipeline
3. **Convergence**: Both paths identical after ortho entry creation and standardization

---

## 🎯 **USER STORIES (EARS Format)**

**US-ODM-001: Raw Image Upload**
- **Given** a user has raw drone images from a flight in ZIP format
- **When** the user uploads the ZIP archive via chunked upload
- **Then** the system shall extract and store images in raw_images directory
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

**US-ODM-003: Legacy Workflow Enhancement**
- **Given** a user has pre-processed orthomosaic
- **When** using existing direct orthomosaic upload workflow
- **Then** the system shall store orthomosaic in archive directory (NO immediate ortho entry)
- **And** the system shall require geotiff processing task to create ortho entry
- **And** the system shall process via unified GeoTIFF → COG → Thumbnail pipeline
- **And** the system shall maintain consistent processing behavior for both upload types
- **Response** consistent processing behavior regardless of upload source

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
- **Then** the system shall automatically detect RTK data presence during upload
- **And** the system shall extract RTK precision indicators from timestamp files (.MRK)
- **And** the system shall store RTK files alongside images in raw_images directory
- **And** the system shall execute ODM with high-precision GPS flags during processing
- **And** the system shall achieve centimeter-level absolute positioning accuracy
- **Response** RTK detection and storage within 5 seconds during upload

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

### **Ortho Table Population Strategy**
**Key Change**: Ortho entries created ONLY during processing, never during upload:

- **GeoTIFF uploads**: File stored in archive/, ortho entry created during geotiff processing task
- **ZIP uploads**: Files extracted to raw_images/, ortho entry created after ODM generates orthomosaic
- **Unified processing**: Both paths use identical ortho creation logic in processor

### **Frontend EXIF Extraction Strategy**
- Extract acquisition date **in frontend** during ZIP selection/preview
- Populate v2_datasets.aquisition_* fields directly via upload API
- Store comprehensive camera metadata in v2_raw_images.camera_metadata
- **Benefits**: Immediate validation, lighter server load, better UX, no technical analysis during upload

### **Task Execution Requirements**
**Critical**: Both upload types MUST include `geotiff` processing task:
- **GeoTIFF uploads**: Queue `['geotiff', 'cog', 'thumbnail', 'metadata']`
- **ZIP uploads**: Queue `['odm_processing', 'geotiff', 'cog', 'thumbnail', 'metadata']`
- **Processor ensures**: GeoTIFF processing always creates ortho entry before other tasks

---

## 🔧 **FUNCTIONAL REQUIREMENTS**

### **FR-ODM-001: Simplified Upload Processing**
- System shall accept both GeoTIFF and ZIP files via chunked upload
- System shall focus upload processing on file storage only (NO technical analysis)
- System shall store GeoTIFF files directly in archive directory without ortho entry creation
- System shall extract ZIP files to raw_images directory and create raw_images database entry
- System shall defer all technical analysis (hash calculation, cog_info, bbox extraction) to processing phase

### **FR-ODM-002: Enhanced EXIF Data Management**
- System shall extract basic acquisition date in frontend during upload for immediate UX (optional - manual entry supported)
- System shall extract comprehensive EXIF data during ODM processing phase from extracted drone images
- System shall store extensive EXIF metadata in v2_raw_images.camera_metadata jsonb field for flexible querying
- System shall handle missing or corrupted EXIF data gracefully without blocking processing
- System shall sample multiple images to find representative EXIF data when individual images lack metadata

### **FR-ODM-002A: RTK Data Detection and Storage**
- System shall automatically detect RTK positioning files in ZIP uploads (.RTK, .MRK, .RTL, .RTB, .RPOS, .RTS, .IMU)
- System shall parse RTK timestamp files (.MRK) to extract precision indicators during upload
- System shall store RTK metadata in v2_raw_images table (has_rtk_data, rtk_precision_cm, rtk_quality_indicator)
- System shall store RTK files alongside images in raw_images directory for processing access

### **FR-ODM-002B: Comprehensive EXIF Metadata Extraction**
- System shall extract comprehensive EXIF metadata during ODM processing after ZIP extraction
- System shall capture camera specifications (make, model, software version, serial number)
- System shall extract image technical settings (ISO, aperture, shutter speed, focal length, white balance)
- System shall record acquisition metadata (datetime, GPS coordinates, altitude, orientation)
- System shall store image properties (dimensions, color space, compression, bit depth)
- System shall store all EXIF data in v2_raw_images.camera_metadata as structured jsonb for efficient querying
- System shall sample first 3 valid images to find representative EXIF data when individual images vary
- System shall continue processing successfully even when EXIF data is missing or corrupted

### **FR-ODM-003: ODM Container Integration with Ortho Creation** 
- System shall execute OpenDroneMap via GPU-accelerated Docker container using Docker-in-Docker
- System shall adapt ODM parameters based on detected RTK data (--force-gps, --gps-accuracy flags)
- System shall generate orthomosaic and move to standard archive location (archive/{dataset_id}_ortho.tif)
- System shall NOT create ortho database entry (delegated to geotiff processing task)
- System shall update ODM completion status only (is_odm_done=True)

### **FR-ODM-004: Unified Ortho Processing Pipeline**
- System shall ensure geotiff processing task included for ALL upload types
- System shall create ortho database entries ONLY during geotiff processing (never during upload)
- System shall perform all technical analysis in processor (hash, cog_info, bbox extraction)
- System shall standardize ALL orthomosaics (both direct upload and ODM-generated)
- System shall use identical ortho creation logic regardless of orthomosaic source

### **FR-ODM-005: Enhanced Queue System Integration**
- System shall require frontend to explicitly queue geotiff processing for GeoTIFF uploads
- System shall ensure ODM tasks execute before geotiff processing within same dataset
- System shall execute tasks in strict order: ODM → GeoTIFF → COG → Thumbnail → Metadata → Deadwood
- System shall maintain fail-fast behavior with proper error recovery and cleanup
- System shall handle both upload types through identical processing pipeline after ortho creation

### **FR-ODM-006: Consistent Orthomosaic Handling**
- System shall store ALL orthomosaics in archive directory regardless of source
- System shall use identical file naming convention: {dataset_id}_ortho.tif
- System shall create ortho database entries with identical structure and metadata
- System shall enable seamless processing pipeline regardless of orthomosaic origin

---

## 📋 **NON-FUNCTIONAL REQUIREMENTS**

### **Performance**
- ZIP upload: ≤ 2 minutes per GB via chunked upload (file storage only)
- GeoTIFF upload: ≤ 30 seconds per GB (file storage only, no technical analysis)
- ODM processing: Variable (1-24 hours depending on image count and complexity)
- Technical analysis: ≤ 5 minutes per orthomosaic during geotiff processing

### **Storage**
- Raw images: Permanent retention in raw_images directory
- Generated orthomosaics: Standard archive directory with existing retention policies
- Unified storage: Both upload types follow identical storage patterns after processing

### **Reliability**
- Upload reliability: ≥ 99.5% (simplified processing reduces failure points)
- ODM success rate: ≥ 90% for valid image sets with proper overlap
- Processing consistency: Identical behavior for both upload types after ortho creation
- Queue integration: No disruption to existing processing workflows

### **Scalability**
- Support up to 10 concurrent uploads (both types)
- Sequential ODM processing (one container at a time with full GPU resources)
- Unified processing: Single pipeline handles both sources efficiently

---

## 🔄 **INTEGRATION POINTS**

### **Modified Components**
- **Upload API**: Simplified to focus on file storage only (no technical analysis)
- **Processor**: Enhanced geotiff processing to handle ortho creation for both sources
- **Queue System**: Ensure geotiff processing included for all upload types
- **Status Tracking**: Consistent tracking regardless of orthomosaic source

### **Unchanged Components**
- **Processing pipeline**: COG, thumbnail, metadata, segmentation unchanged after ortho creation
- **Database structure**: Minimal extensions (new raw_images table only)
- **User interface**: Upload methods enhanced but processing interface unchanged
- **Download and access**: Identical behavior regardless of orthomosaic source

### **New Components**
- **Raw Images Table**: Track metadata for uploaded raw image sets
- **ODM Processing Function**: Handle Docker container execution and orthomosaic generation
- **Unified Ortho Creation**: Single logic path for ortho entry creation in processor
- **Enhanced GeoTIFF Processing**: Handles ortho creation for both direct and ODM-generated files

---

## ✅ **SUCCESS CRITERIA**

1. **Users can upload both GeoTIFF and ZIP files with consistent, fast upload experience**
2. **All technical analysis and ortho creation happens in processor for both upload types**
3. **ODM generates orthomosaic and integrates seamlessly with existing processing pipeline**
4. **Both upload types result in identical database state after geotiff processing**
5. **Existing GeoTIFF workflow enhanced with consistent processor-centric approach**
6. **No code duplication between upload and processing technical analysis**
7. **Processing pipeline behavior identical regardless of orthomosaic source**
8. **System handles processing failures gracefully with unified error handling**

---

**Document Status**: UPDATED - Processor-Centric Architecture  
**Implementation Scope**: Backend integration with simplified upload and enhanced processing  
**Technical Details**: See `design.md` for implementation specifications and `implementation.md` for step-by-step tasks  
**Architecture Principle**: Upload stores files, processor creates ortho entries and performs all technical analysis 