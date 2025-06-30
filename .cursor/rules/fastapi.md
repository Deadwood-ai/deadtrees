---
description: FastAPI patterns for DeadTrees project
globs: ["api/**/*.py"]
alwaysApply: true
---

# FastAPI Guidelines

## Core Principles
- Use functional programming, avoid classes where possible
- Use `def` for sync operations, `async def` for async operations
- Use Pydantic models for input validation and response schemas
- RORO pattern: Receive an Object, Return an Object

## Error Handling
- Handle errors at function start, use early returns
- Use HTTPException for expected errors
- Use middleware for unexpected errors and logging

```python
from fastapi import HTTPException
from pydantic import BaseModel

class DatasetRequest(BaseModel):
    file_name: str
    user_id: str

@app.post("/datasets")
async def create_dataset(request: DatasetRequest) -> DatasetResponse:
    # Validation first
    if not request.file_name:
        raise HTTPException(status_code=400, detail="File name required")
    
    # Happy path
    result = await process_dataset(request)
    return DatasetResponse(success=True, dataset_id=result.id)
```

## Performance
- Use async functions for I/O-bound tasks (database, external APIs)
- Use dependency injection for shared resources
- Implement caching for frequently accessed data

## Configuration
```python
# Development vs Production
UVICORN_HOST = '127.0.0.1' if DEV_MODE else '0.0.0.0'
UVICORN_PORT = 8017 if DEV_MODE else 8000
UVICORN_ROOT_PATH = '/api/v1'
```

## Response Structure
```python
# Consistent error responses
{
    "error": {
        "code": "ERROR_CODE",
        "message": "User-friendly message"
    }
}
``` 