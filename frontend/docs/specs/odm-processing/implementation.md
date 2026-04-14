# ODM Frontend Implementation - Simplified ZIP Upload Support

---

## 📋 **SIMPLIFIED OVERVIEW**

This document outlines the minimal frontend changes needed to support ODM raw drone image upload, leveraging the existing robust upload infrastructure.

**Key Principles:**

- Leverage existing chunked upload system (already compatible with new backend)
- Backend handles EXIF extraction and auto-detection
- Minimal frontend processing (file validation only)
- Extend current UI rather than rebuild
- 30GB file size limit for ZIP files

---

## Rules & Tips

## 🔍 **DATABASE SCHEMA VALIDATION**

**Critical Finding:** Database schema analysis revealed that ODM support infrastructure already exists:

✅ **Ready in Database:**

- `v2_statuses.is_odm_done` - ODM processing completion tracking
- `v2_raw_images` table - Raw image metadata storage (image count, size, camera metadata, RTK data)
- `v2_full_dataset_view.is_odm_done` - Available in main frontend data view
- ODM processing status in `v2_status` enum

⚠️ **Missing in Frontend:**

- `is_odm_done` field missing from `IDataset` interface
- Progress calculation doesn't include ODM step
- Dataset subscription doesn't track ODM status changes

**Impact:** The database is more ready than expected, but frontend types and logic need updates to match the existing schema.

---

## 🎯 **IMPLEMENTATION TASKS**

### **Task 1: Fix Frontend-Database Type Mismatch**

**Context:** Database schema analysis revealed that ODM support already exists, but frontend types are missing critical fields.

**Subtasks:**

- [x] Add `UploadType` enum to `src/types/dataset.ts`

```typescript
export enum UploadType {
  GEOTIFF = "geotiff",
  RAW_IMAGES_ZIP = "raw_images_zip",
}
```

- [x] Add missing `is_odm_done` field to `IDataset` interface in `src/types/dataset.ts`

```typescript
export interface IDataset {
  // ... existing fields
  is_odm_done: boolean; // ← ADD THIS MISSING FIELD
  // ... rest of fields
}
```

**Note:** Database schema validation confirmed that `v2_statuses.is_odm_done` and `v2_full_dataset_view.is_odm_done` already exist, but the frontend interface was missing this field.

### **Task 2: Update Upload Modal**

**Context:** Extend existing upload interface to accept ZIP files with validation.

**Subtasks:**

- [x] Update file input accept attribute in `src/components/Upload/UploadModal.tsx`

  - Change from `accept=".tif,.tiff"` to `accept=".tif,.tiff,.zip"`

- [x] Add file type detection utility
  - Simple extension-based detection for UI behavior
  - Located in `src/utils/` directory

```typescript
export const detectUploadType = (fileName: string): UploadType => {
  const ext = fileName.toLowerCase().split(".").pop();
  if (["tif", "tiff"].includes(ext || "")) {
    return UploadType.GEOTIFF;
  } else if (ext === "zip") {
    return UploadType.RAW_IMAGES_ZIP;
  }
  throw new Error(`Unsupported file type: ${ext}`);
};
```

- [x] Add file size validation for ZIP files

  - 30GB limit for ZIP files
  - Show clear error message if exceeded
  - 20GB limit for GeoTIFF files

- [x] Update upload modal help text
  - Add mention of ZIP file support for raw drone images
  - Explain ODM processing workflow

### **Task 3: Update Progress Indication System**

**Context:** Add ODM processing step for raw drone image uploads and update progress calculation to use `is_odm_done` field.

**Subtasks:**

- [x] Extend `src/utils/processingSteps.ts`
  - Add new ODM processing step
  - Show different steps based on upload type
  - Update progress calculation to include `is_odm_done` status

```typescript
export const GEOTIFF_PROCESSING_STEPS: ProcessingStep[] = [
  // Existing steps for GeoTIFF uploads
  { key: "upload", label: "Uploading", description: "Uploading your data to the platform" },
  { key: "ortho", label: "Processing Image", description: "Processing and validating your orthophoto" },
  { key: "metadata", label: "Extracting Information", description: "Extracting geographic and technical metadata" },
  { key: "cog", label: "Optimizing Data", description: "Converting to optimized format for visualization" },
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood detection" },
];

export const RAW_IMAGES_PROCESSING_STEPS: ProcessingStep[] = [
  // New workflow for raw drone images
  { key: "upload", label: "Uploading", description: "Uploading your raw drone images" },
  { key: "odm", label: "ODM Processing", description: "Creating orthomosaic from raw drone images" },
  { key: "ortho", label: "Processing Image", description: "Processing and validating your orthophoto" },
  { key: "metadata", label: "Extracting Information", description: "Extracting geographic and technical metadata" },
  { key: "cog", label: "Optimizing Data", description: "Converting to optimized format for visualization" },
  { key: "deadwood", label: "AI Analysis", description: "Running AI analysis for deadwood detection" },
];
```

- [x] Update `calculateProcessingProgress()` function to include `is_odm_done` in step completion checks
- [x] Add file type detection to progress components to show appropriate steps
- [x] Update `useDatasetSubscription` hook to track `is_odm_done` changes for real-time progress updates

**Note:** Database has `v2_statuses.is_odm_done` field ready for tracking ODM processing completion.

### **Task 4: Update Help Documentation**

**Context:** Add guidance for raw drone image uploads.

**Subtasks:**

- [x] Update account page Alert component

  - Add section explaining raw drone image upload support
  - Include requirements (overlap, formats, etc.)
  - Mention ODM processing workflow

- [x] Update upload modal help text
  - Explain difference between GeoTIFF and raw image workflows
  - Add file size limits and format requirements

**Sample help text:**

```
**New: Raw Drone Image Support**
- Upload ZIP files containing raw drone images (JPEG, JPG, TIF)
- Images will be processed into orthomosaics using ODM (OpenDroneMap)
- Ensure 60-80% image overlap for best results
- Maximum file size: 30GB
- Processing time varies based on image count and quality
```

---

## 🔧 **TECHNICAL DETAILS**

### **File Size Validation**

```typescript
const validateFileSize = (file: File, uploadType: UploadType): boolean => {
  const MAX_ZIP_SIZE = 30 * 1024 * 1024 * 1024; // 30GB
  const MAX_GEOTIFF_SIZE = 20 * 1024 * 1024 * 1024; // 20GB

  if (uploadType === UploadType.RAW_IMAGES_ZIP && file.size > MAX_ZIP_SIZE) {
    throw new Error("ZIP files must be smaller than 30GB");
  }
  if (uploadType === UploadType.GEOTIFF && file.size > MAX_GEOTIFF_SIZE) {
    throw new Error("GeoTIFF files must be smaller than 20GB");
  }
  return true;
};
```

### **Backend Integration**

- Existing `uploadOrtho.ts` already compatible with new backend endpoint
- Backend handles auto-detection via filename
- No changes needed to chunked upload mechanism
- Backend extracts EXIF data automatically

### **UI Behavior**

- Same form fields for both upload types
- Progress indication adapts based on detected file type
- Error handling remains unchanged
- Existing notification system works for both workflows

---

## 📁 **FILES TO MODIFY**

1. `src/types/dataset.ts` - Add UploadType enum and missing `is_odm_done` field
2. `src/components/Upload/UploadModal.tsx` - File input and validation
3. `src/utils/processingSteps.ts` - Add ODM processing steps and update progress calculation
4. `src/utils/fileValidation.ts` - File type detection and validation (new file)
5. `src/hooks/useDatasetSubscription.ts` - Track `is_odm_done` changes
6. Account page Alert component - Add raw drone image documentation

---

## ✅ **IMPLEMENTATION CHECKLIST**

### **Critical Database Schema Fixes:**

- [x] Add missing `is_odm_done` field to `IDataset` interface
- [x] Update `calculateProcessingProgress()` to include ODM step
- [x] Update `useDatasetSubscription` to track `is_odm_done` changes

### **Core Upload Support:**

- [x] Add UploadType enum to types
- [x] Update file input accept attribute to include `.zip`
- [x] Add file size validation for ZIP files (30GB limit)
- [x] Create file type detection utility

### **Progress & UI Updates:**

- [x] Add ODM processing step to progress indication
- [x] Show different processing workflows based on file type
- [x] Update help text in upload modal
- [x] Update account page documentation

### **Testing & Validation:**

- [ ] Test with both GeoTIFF and ZIP uploads
- [ ] Verify progress indication works correctly for both workflows
- [ ] Verify real-time status updates include ODM processing
- [ ] Test file size validation and error handling

---

**Document Status**: Ready for Implementation  
**Estimated Timeline**: 1-2 days  
**Dependencies**: Backend ODM endpoint must be functional
