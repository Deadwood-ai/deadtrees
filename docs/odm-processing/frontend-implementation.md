# ODM Frontend Implementation - EXIF Extraction & Upload Enhancement

**Version:** 1.0  
**Date:** December 2024  
**Status:** Ready for Implementation

---

## 📋 **FRONTEND OVERVIEW**

This document outlines the frontend implementation for ODM raw drone image upload support, focusing on EXIF extraction and user experience improvements.

**Key Principles:**
- Extract acquisition date in frontend for immediate validation
- Enhance existing upload interface rather than rebuild
- Maintain backward compatibility with current GeoTIFF workflow
- Provide clear feedback on ZIP content and metadata

---

## 🌐 **PHASE 1: EXIF EXTRACTION SYSTEM**

### **Task 1.1: Dependencies & Setup**

**Context:** Need EXIF reading capability for ZIP files containing drone images.

**Subtasks:**
- [ ] Add EXIF reading library to frontend dependencies
  - Add `exif-js` or `piexifjs` to package.json  
  - Choose library with good TypeScript support and ZIP compatibility
  - Evaluate performance with large image files

- [ ] Add ZIP handling library if not present
  - Add `jszip` for ZIP file processing
  - Ensure compatibility with existing build pipeline

**Installation:**
```bash
npm install exif-js jszip
npm install --save-dev @types/exif-js
```

### **Task 1.2: EXIF Extraction Utilities**

**Context:** Extract meaningful metadata from drone images for form population and validation.

**Subtasks:**
- [ ] Create `utils/exifExtractor.ts` for image metadata reading
  - Extract acquisition date, camera info, GPS coordinates
  - Handle missing/corrupted EXIF data gracefully
  - Support JPEG, JPG, TIF formats

```typescript
// Example implementation structure
interface ExifData {
  acquisitionDate?: Date;
  cameraInfo?: {
    make?: string;
    model?: string;
    serialNumber?: string;
  };
  gpsCoordinates?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
  imageSettings?: {
    iso?: number;
    aperture?: number;
    shutterSpeed?: number;
    focalLength?: number;
  };
}

export const extractExifFromImage = async (imageBlob: Blob): Promise<ExifData> => {
  // Implementation using exif-js
};

export const extractAcquisitionFromZip = async (zipFile: File): Promise<Date | null> => {
  const zip = await JSZip.loadAsync(zipFile);
  const imageFiles = Object.keys(zip.files).filter(isImageFile);
  
  // Check first 5 images for acquisition date
  for (const fileName of imageFiles.slice(0, 5)) {
    const imageBlob = await zip.files[fileName].async('blob');
    const exifData = await extractExifFromImage(imageBlob);
    if (exifData.acquisitionDate) {
      return exifData.acquisitionDate;
    }
  }
  return null;
};

const isImageFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ['jpg', 'jpeg', 'tif', 'tiff'].includes(ext || '');
};
```

### **Task 1.3: ZIP Validation & Preview**

**Context:** Validate ZIP contents and provide user feedback before upload.

**Subtasks:**
- [ ] Implement ZIP content validation
  - Check for minimum 3 image files
  - Validate file formats (JPEG/JPG/TIF)
  - Calculate total size and image count
  - Detect unsupported file types

- [ ] Create metadata preview component
  - Show detected acquisition date
  - Display image count and total size
  - Show camera information if available
  - Indicate any validation issues

```typescript
interface ZipValidationResult {
  isValid: boolean;
  imageCount: number;
  totalSizeMB: number;
  detectedAcquisitionDate?: Date;
  cameraInfo?: string;
  errors: string[];
  warnings: string[];
}

export const validateZipForODM = async (zipFile: File): Promise<ZipValidationResult> => {
  const zip = await JSZip.loadAsync(zipFile);
  const result: ZipValidationResult = {
    isValid: true,
    imageCount: 0,
    totalSizeMB: 0,
    errors: [],
    warnings: []
  };
  
  // Validation logic
  // ...
  
  return result;
};
```

---

## 🎯 **PHASE 2: UPLOAD INTERFACE ENHANCEMENT**

### **Task 2.1: File Type Detection & Routing**

**Context:** Enhance existing upload interface to handle both GeoTIFF and ZIP files.

**Subtasks:**
- [ ] Extend file input to accept ZIP files
  - Update accept attribute: `.tif,.tiff,.zip`
  - Add file type detection on selection
  - Route to appropriate processing logic

- [ ] Implement smart upload type detection
  - Automatically detect file type from extension
  - Show appropriate form fields based on type
  - Maintain existing GeoTIFF workflow unchanged

```typescript
enum UploadType {
  GEOTIFF = 'geotiff',
  RAW_IMAGES_ZIP = 'raw_images_zip'
}

const detectUploadType = (file: File): UploadType => {
  const ext = file.name.toLowerCase().split('.').pop();
  if (['tif', 'tiff'].includes(ext || '')) {
    return UploadType.GEOTIFF;
  } else if (ext === 'zip') {
    return UploadType.RAW_IMAGES_ZIP;
  }
  throw new Error(`Unsupported file type: ${ext}`);
};
```

### **Task 2.2: Form Enhancement & Auto-Population**

**Context:** Auto-populate acquisition date and provide better user experience.

**Subtasks:**
- [ ] Integrate EXIF extraction with upload form
  - Trigger EXIF extraction on ZIP file selection
  - Auto-populate acquisition date fields
  - Show loading state during extraction
  - Allow manual override if needed

- [ ] Add ZIP preview section
  - Show validation results
  - Display detected metadata
  - Indicate processing readiness
  - Provide clear error messages

```typescript
const handleFileSelection = async (file: File) => {
  const uploadType = detectUploadType(file);
  
  if (uploadType === UploadType.RAW_IMAGES_ZIP) {
    setIsExtracting(true);
    try {
      const validation = await validateZipForODM(file);
      setZipValidation(validation);
      
      if (validation.detectedAcquisitionDate) {
        setAcquisitionDate(validation.detectedAcquisitionDate);
      }
    } catch (error) {
      setError(`Failed to process ZIP file: ${error.message}`);
    } finally {
      setIsExtracting(false);
    }
  }
};
```

### **Task 2.3: Upload Progress & Feedback**

**Context:** Provide clear feedback during ZIP upload and processing initiation.

**Subtasks:**
- [ ] Enhance upload progress for ZIP files
  - Show chunked upload progress
  - Indicate ZIP extraction phase
  - Display ODM processing queue status
  - Provide estimated processing time

- [ ] Add post-upload status tracking
  - Show current processing stage
  - Indicate ODM processing progress
  - Display error states clearly
  - Link to processing queue status

---

## 🎨 **PHASE 3: USER EXPERIENCE**

### **Task 3.1: Error Handling & Validation**

**Context:** Provide clear feedback for common issues with raw drone images.

**Subtasks:**
- [ ] Implement comprehensive error handling
  - Invalid ZIP structure
  - Missing EXIF data
  - Insufficient image count
  - Unsupported file formats
  - File size limitations

- [ ] Add validation messages
  - Clear explanations of requirements
  - Suggestions for fixing issues
  - Links to documentation
  - Examples of valid uploads

### **Task 3.2: Help & Documentation**

**Context:** Guide users through raw drone image upload process.

**Subtasks:**
- [ ] Add help section for raw image uploads
  - Explain ODM processing workflow
  - List supported drone models/formats
  - Provide example flight planning tips
  - Link to ODM documentation

- [ ] Create upload guidelines
  - Image overlap requirements
  - Flight altitude recommendations
  - File naming conventions
  - Quality considerations

---

## 🔧 **IMPLEMENTATION NOTES**

### **Performance Considerations**
- Limit EXIF extraction to first 5 images to avoid UI blocking
- Use Web Workers for large ZIP processing if needed
- Implement chunked reading for very large ZIP files
- Cache validation results during form interaction

### **Browser Compatibility**
- Ensure ZIP processing works across target browsers
- Provide fallbacks for missing EXIF data
- Handle file size limitations gracefully
- Test with various ZIP compression methods

### **Security**
- Validate file types on frontend and backend
- Sanitize extracted metadata before display
- Limit ZIP extraction memory usage
- Prevent zip bomb attacks with size limits

### **Integration Points**
- Use existing chunked upload mechanism
- Maintain current authentication flow
- Leverage existing error handling patterns
- Follow established form validation patterns

---

**Document Status**: Ready for Implementation  
**Dependencies**: Backend ODM implementation must be completed first  
**Estimated Timeline**: 2-3 weeks after backend completion 