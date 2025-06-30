---
description: Data processing pipeline for DeadTrees project
globs: ["processor/**/*.py"]
alwaysApply: true
---

# Data Processing Guidelines

## Processing Pipeline
Sequential processing stages:
1. **GeoTIFF Standardization** - Normalize input rasters
2. **Metadata Extraction** - Extract geographic and biome data
3. **COG Generation** - Create Cloud Optimized GeoTIFFs
4. **Thumbnail Creation** - Generate preview images
5. **Deadwood Segmentation** - AI-powered forest analysis

## Local File Reuse
- Check for existing processed files before reprocessing
- Use file hashing to verify integrity
- Reuse COGs and thumbnails when source unchanged

```python
def process_dataset(dataset_id: int) -> ProcessingResult:
    # Check existing files first
    cog_path = get_cog_path(dataset_id)
    if os.path.exists(cog_path) and verify_cog_integrity(cog_path):
        logger.info("Reusing existing COG", context=context)
        return ProcessingResult(cog_path=cog_path)
    
    # Process if needed
    return create_new_cog(dataset_id)
```

## GPU Processing
- Use GPU acceleration for AI segmentation models
- Fallback to CPU if GPU unavailable
- Monitor GPU memory usage

## Error Handling
- Retry transient failures (network, temporary file locks)
- Fail fast on permanent errors (corrupted files, invalid formats)
- Log processing context for debugging

```python
def process_with_retry(operation: Callable, max_retries: int = 3) -> Any:
    for attempt in range(max_retries):
        try:
            return operation()
        except TransientError as e:
            if attempt < max_retries - 1:
                logger.warning(f"Retry {attempt + 1}/{max_retries}: {e}")
                time.sleep(2 ** attempt)  # Exponential backoff
            else:
                raise
        except PermanentError:
            raise  # Don't retry permanent errors
``` 