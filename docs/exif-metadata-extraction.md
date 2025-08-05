# EXIF Metadata Extraction Documentation

**Version:** 1.0  
**Date:** January 2025  
**Status:** Production Ready

## Overview

The DeadTrees platform provides comprehensive EXIF metadata extraction for drone images uploaded as part of raw image ZIP files. This system automatically extracts camera metadata during the ODM processing pipeline and stores it in a flexible, queryable format.

## Features

- **Automatic EXIF Extraction**: Runs during ODM processing (Step 2.5)
- **Multi-Manufacturer Support**: Supports DJI, Canon, Sony, Nikon, Parrot, and other drone/camera systems
- **Flexible Schema**: Uses JSONB storage for maximum compatibility across camera types
- **Efficient Querying**: PostgreSQL GIN index enables fast JSON queries
- **Comprehensive Metadata**: Extracts camera info, image settings, GPS data, and technical specifications

## Database Schema

### v2_raw_images Table

The EXIF metadata is stored in the `camera_metadata` column:

```sql
CREATE TABLE v2_raw_images (
    dataset_id bigint PRIMARY KEY,
    raw_image_count integer NOT NULL,
    raw_image_size_mb integer NOT NULL,
    raw_images_path text NOT NULL,
    camera_metadata jsonb,  -- ← EXIF metadata stored here
    has_rtk_data boolean DEFAULT false,
    rtk_precision_cm numeric,
    rtk_quality_indicator integer,
    rtk_file_count integer DEFAULT 0,
    version integer DEFAULT 1,
    created_at timestamptz DEFAULT now()
);

-- GIN index for efficient JSON queries
CREATE INDEX v2_raw_images_camera_metadata_gin_idx 
ON v2_raw_images USING gin (camera_metadata);
```

### Camera Metadata Structure

The `camera_metadata` field contains a flexible JSONB structure that varies by manufacturer:

```json
{
  "Make": "DJI",
  "Model": "Mavic 3",
  "Software": "DJI GO 4",
  "DateTime": "2025:04:03 12:53:33",
  "ISOSpeedRatings": 100,
  "FNumber": 2.8,
  "FocalLength": 12.29,
  "ExposureTime": "1/2000",
  "ExifImageWidth": 5280,
  "ExifImageHeight": 3956,
  "GPSLatitude": [52.5, "N"],
  "GPSLongitude": [13.4, "E"],
  "GPSAltitude": 145.8,
  "WhiteBalance": "Auto",
  "ColorSpace": 1
}
```

## Available EXIF Fields

### Camera Information
- `Make`: Camera/drone manufacturer (e.g., "DJI", "Canon", "Sony")
- `Model`: Camera/drone model (e.g., "Mavic 3", "EOS R5")
- `Software`: Software version used for capture
- `LensModel`: Lens information (for interchangeable lens systems)

### Image Settings
- `ISOSpeedRatings`: ISO sensitivity setting
- `FNumber`: Aperture setting (f-stop)
- `FocalLength`: Focal length in millimeters
- `ExposureTime`: Shutter speed (e.g., "1/2000")
- `WhiteBalance`: White balance setting
- `Flash`: Flash settings and status

### Acquisition Details
- `DateTime`: Primary timestamp when image was captured
- `DateTimeOriginal`: Original capture timestamp
- `DateTimeDigitized`: When image was digitized
- `GPSLatitude`: GPS latitude coordinates
- `GPSLongitude`: GPS longitude coordinates
- `GPSAltitude`: GPS altitude in meters
- `GPSTimeStamp`: GPS timestamp

### Technical Specifications
- `ExifImageWidth`: Image width in pixels
- `ExifImageHeight`: Image height in pixels
- `XResolution`: Horizontal resolution
- `YResolution`: Vertical resolution
- `ColorSpace`: Color space information
- `Compression`: Image compression details

## Manufacturer-Specific Examples

### DJI Drones
```json
{
  "Make": "DJI",
  "Model": "Air 2S",
  "Software": "DJI GO 4",
  "DateTime": "2025:04:03 12:53:33",
  "ISOSpeedRatings": 100,
  "FNumber": 2.8,
  "FocalLength": 22.0,
  "GPSLatitude": [48.0, "N"],
  "GPSLongitude": [8.0, "E"],
  "GPSAltitude": 120.5
}
```

### Canon Cameras
```json
{
  "Make": "Canon",
  "Model": "EOS R5",
  "LensModel": "RF24-70mm F2.8 L IS USM",
  "DateTime": "2025:04:03 14:22:10",
  "ISOSpeedRatings": 400,
  "FNumber": 4.0,
  "FocalLength": 50.0,
  "ExposureTime": "1/1000"
}
```

### Sony Cameras
```json
{
  "Make": "Sony",
  "Model": "Alpha 7R IV",
  "LensInfo": [24, 70, 2.8, 2.8],
  "DateTime": "2025:04:03 16:45:22",
  "ISOSpeedRatings": 200,
  "FNumber": 3.5,
  "FocalLength": 35.0
}
```

## Database Query Examples

### Basic Field Extraction
```sql
-- Get camera manufacturer
SELECT camera_metadata->>'Make' as manufacturer
FROM v2_raw_images
WHERE dataset_id = 123;

-- Get all camera settings
SELECT 
    camera_metadata->>'Make' as make,
    camera_metadata->>'Model' as model,
    camera_metadata->>'ISOSpeedRatings' as iso,
    camera_metadata->>'FNumber' as aperture
FROM v2_raw_images
WHERE dataset_id = 123;
```

### GPS Data Queries
```sql
-- Check if GPS data exists
SELECT dataset_id
FROM v2_raw_images
WHERE camera_metadata ? 'GPSLatitude'
  AND camera_metadata ? 'GPSLongitude';

-- Extract GPS coordinates
SELECT 
    dataset_id,
    camera_metadata->>'GPSLatitude' as latitude,
    camera_metadata->>'GPSLongitude' as longitude,
    camera_metadata->>'GPSAltitude' as altitude
FROM v2_raw_images
WHERE camera_metadata ? 'GPSLatitude';
```

### Manufacturer-Specific Queries
```sql
-- Find all DJI drone datasets
SELECT dataset_id
FROM v2_raw_images
WHERE camera_metadata->>'Make' = 'DJI';

-- Find datasets with specific camera settings
SELECT dataset_id
FROM v2_raw_images
WHERE camera_metadata->>'ISOSpeedRatings'::int > 400
  AND camera_metadata->>'FNumber'::float < 4.0;
```

### Complex JSON Operations
```sql
-- Count datasets by manufacturer
SELECT 
    camera_metadata->>'Make' as manufacturer,
    COUNT(*) as dataset_count
FROM v2_raw_images
WHERE camera_metadata->>'Make' IS NOT NULL
GROUP BY camera_metadata->>'Make';

-- Find datasets with GPS and high image quality
SELECT dataset_id
FROM v2_raw_images
WHERE camera_metadata ? 'GPSLatitude'
  AND camera_metadata->>'ExifImageWidth'::int >= 4000
  AND camera_metadata->>'ISOSpeedRatings'::int <= 200;
```

## API Integration

### Upload Process
EXIF extraction is automatically triggered during raw image ZIP uploads:

1. Upload ZIP file via `/datasets/chunk` endpoint
2. System detects upload type as `RAW_IMAGES_ZIP`
3. Files are extracted and stored in `raw_images/{dataset_id}/`
4. Processing task with `odm_processing` type is created
5. ODM processing extracts EXIF metadata (Step 2.5)
6. Metadata is stored in `v2_raw_images.camera_metadata`

### Accessing Metadata
While there's no direct API endpoint for camera metadata, it can be accessed through:

1. **Database Integration**: Direct queries to `v2_raw_images` table
2. **Processing Pipeline**: Metadata is available during subsequent processing tasks
3. **Download Bundles**: Metadata could be included in future dataset download formats

## Processing Pipeline Integration

### ODM Processing Step 2.5: EXIF Extraction

```python
# Automatic EXIF extraction during ODM processing
def process_odm(task: QueueTask, temp_dir: Path):
    # ... ZIP extraction ...
    
    # Step 2.5: Extract EXIF metadata
    exif_data = _extract_exif_from_images(extraction_dir)
    _update_camera_metadata(task.dataset_id, exif_data, token)
    
    # ... Continue with ODM processing ...
```

### EXIF Extraction Function

```python
from shared.exif_utils import extract_comprehensive_exif

def _extract_exif_from_images(extraction_dir: Path) -> Dict[str, Any]:
    """Extract EXIF metadata from first valid image file"""
    image_extensions = {'.jpg', '.jpeg', '.tif', '.tiff'}
    
    for image_file in extraction_dir.rglob('*'):
        if image_file.suffix.lower() in image_extensions:
            exif_data = extract_comprehensive_exif(image_file)
            if exif_data:  # Found valid EXIF data
                return exif_data
    
    return {}  # No EXIF data found
```

## Error Handling

The EXIF extraction system is designed to be robust:

- **Missing EXIF Data**: Returns empty dictionary `{}`
- **Corrupted Images**: Gracefully handles invalid image files
- **Unsupported Formats**: Skips non-image files automatically
- **Encoding Issues**: Handles various text encodings in EXIF data
- **Non-JSON Data**: Filters out non-serializable data types

## Testing

### Test Coverage
- ✅ Real DJI drone image EXIF extraction
- ✅ Multiple image format support (JPG, JPEG, TIF)
- ✅ GPS data extraction and validation
- ✅ Missing/incomplete EXIF data handling
- ✅ Database storage and retrieval
- ✅ JSON query performance
- ✅ Multi-manufacturer compatibility

### Running EXIF Tests
```bash
# EXIF extraction tests
deadtrees dev test processor processor/tests/test_exif_extraction.py

# ODM integration tests
deadtrees dev test processor processor/tests/test_process_odm.py

# Pipeline integration tests
deadtrees dev test processor processor/tests/test_exif_integration.py
```

## Performance Considerations

### Database Performance
- **GIN Index**: Efficient JSON field queries
- **Selective Queries**: Use specific field extraction for better performance
- **Batch Operations**: Consider batch processing for multiple datasets

### Storage Efficiency
- **JSONB Format**: Compressed binary JSON storage
- **Flexible Schema**: No rigid structure requirements
- **Null Handling**: Missing fields are omitted, not stored as null

## Future Enhancements

### Potential API Endpoints
```
GET /datasets/{dataset_id}/metadata/camera
GET /datasets/{dataset_id}/metadata/exif
GET /datasets/search?manufacturer=DJI&has_gps=true
```

### Enhanced Metadata
- **Image Quality Metrics**: Blur detection, exposure analysis
- **Georeferencing**: Coordinate system transformations
- **Temporal Analysis**: Flight path reconstruction from timestamps
- **Equipment Profiles**: Camera/lens calibration data

## Support

### Supported Camera Types
- ✅ **DJI Drones**: Mavic series, Air series, Phantom series
- ✅ **Canon DSLRs**: EOS series with various lenses
- ✅ **Sony Cameras**: Alpha series, FX series
- ✅ **Nikon Cameras**: D series, Z series
- ✅ **Parrot Drones**: ANAFI series
- ✅ **Generic Cameras**: Any camera producing standard EXIF data

### File Format Support
- ✅ **JPEG/JPG**: Primary drone image format
- ✅ **TIFF**: High-quality image format
- ✅ **Various Encodings**: UTF-8, ASCII, Latin-1
- ✅ **Mixed Archives**: ZIP files with multiple image formats

## Troubleshooting

### Common Issues

**No EXIF Data Extracted**
- Verify images have EXIF data (some processed images may have stripped metadata)
- Check image file formats are supported
- Ensure images are not corrupted

**Incomplete GPS Data**
- Some indoor/manual flights may not have GPS enabled
- GPS coordinates may be in different EXIF fields depending on manufacturer
- Check for both `GPSLatitude` and `GPSLongitude` fields

**Query Performance Issues**
- Ensure GIN index exists on `camera_metadata` column
- Use specific field extraction (`->>`) instead of full object queries
- Consider adding additional indexes for frequently queried fields

### Debug Commands
```sql
-- Check if GIN index exists
SELECT schemaname, tablename, indexname 
FROM pg_indexes 
WHERE tablename = 'v2_raw_images' 
  AND indexname LIKE '%gin%';

-- Analyze EXIF data distribution
SELECT 
    camera_metadata->>'Make' as make,
    COUNT(*) as count,
    AVG(jsonb_array_length(jsonb_object_keys(camera_metadata))) as avg_fields
FROM v2_raw_images
WHERE camera_metadata IS NOT NULL
GROUP BY camera_metadata->>'Make';
```

---

## Summary

The EXIF metadata extraction system provides comprehensive, flexible, and efficient access to camera metadata from drone images. It supports multiple manufacturers, handles real-world data variations gracefully, and provides powerful query capabilities through PostgreSQL's JSONB features.

For technical implementation details, see the source code in:
- `shared/exif_utils.py` - Core EXIF extraction functions
- `processor/src/process_odm.py` - ODM processing integration
- `processor/tests/test_exif_*.py` - Comprehensive test suite 