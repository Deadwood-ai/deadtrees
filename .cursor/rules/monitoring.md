---
description: Logging and monitoring for DeadTrees project
globs: ["shared/logging.py", "**/logs/**/*"]
alwaysApply: true
---

# Monitoring Guidelines

## Structured Logging
- Use UnifiedLogger for all logging operations
- Always include LogContext for structured data
- Use LogCategory enum for operation categorization

```python
from shared.logging import UnifiedLogger, LogContext, LogCategory

logger = UnifiedLogger()
context = LogContext(
    category=LogCategory.UPLOAD,
    dataset_id=dataset_id,
    user_id=user_id
)

logger.info("Processing started", context=context)
logger.error("Processing failed", context=context.with_extra({
    'error_type': type(e).__name__,
    'error_details': str(e)
}))
```

## Log Categories
- `UPLOAD` - File upload operations
- `PROCESS` - Data processing operations
- `COG` - COG generation
- `THUMBNAIL` - Thumbnail generation
- `METADATA` - Metadata extraction
- `DEADWOOD` - Deadwood segmentation

## Database Logging
- Logs automatically stored in `v2_logs` table
- Include relevant IDs (dataset_id, user_id) for filtering
- Use appropriate log levels (INFO, ERROR, WARNING)

## External Monitoring
- Logfire integration for performance monitoring
- Track processing times and resource usage
- Monitor API response times and error rates 