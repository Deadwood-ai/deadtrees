---
description: Python coding standards for DeadTrees project
globs: ["**/*.py"]
alwaysApply: true
---

# Python Guidelines

## Code Style
- Follow PEP 8, max line length: 120 characters
- Use single quotes, tabs for indentation (per Ruff config)
- Import order: stdlib, third-party, local (with blank lines between)

## Type Hints & Validation
- Use type hints for all function signatures
- Use Pydantic models for data validation
- Prefer composition over inheritance

```python
from typing import Optional, List
from pydantic import BaseModel

def process_dataset(dataset_id: int, options: Optional[dict] = None) -> Dataset:
    pass

class DatasetRequest(BaseModel):
    file_name: str
    user_id: str
    metadata: Optional[dict] = None
```

## Error Handling
- Error-first design: handle errors at function start, use early returns
- Custom exception hierarchy with DeadTreesError base class
- Use structured logging with LogContext

```python
def process_file(file_path: str, dataset_id: int) -> ProcessingResult:
    # Error handling first
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
    
    if dataset_id <= 0:
        raise ValueError("Dataset ID must be positive")
    
    # Happy path
    return perform_processing(file_path, dataset_id)
```

## Async Patterns
- Use `async def` for I/O operations, `def` for CPU-bound
- Use context managers for resource cleanup
- RORO pattern: Receive an Object, Return an Object

## Logging
```python
from shared.logging import UnifiedLogger, LogContext, LogCategory

logger = UnifiedLogger()
context = LogContext(category=LogCategory.PROCESS, dataset_id=dataset_id)
logger.info("Processing started", context=context)
```

## Function Design Patterns

### Functional Programming Principles
- Use `def` for pure functions and `async def` for asynchronous operations
- Prefer functional, declarative programming; avoid classes where possible
- Prefer iteration and modularization over code duplication
- Use descriptive variable names with auxiliary verbs (e.g., `is_active`, `has_permission`)

### RORO Pattern (Receive an Object, Return an Object)
```python
from pydantic import BaseModel

class ProcessingRequest(BaseModel):
    dataset_id: int
    user_id: str
    options: Dict[str, Any] = {}

class ProcessingResponse(BaseModel):
    success: bool
    result_id: Optional[str] = None
    error_message: Optional[str] = None
    processing_time: float

def process_dataset(request: ProcessingRequest) -> ProcessingResponse:
    """Process dataset using RORO pattern"""
    start_time = time.time()
    
    try:
        result = perform_processing(request.dataset_id, request.user_id, request.options)
        return ProcessingResponse(
            success=True,
            result_id=result.id,
            processing_time=time.time() - start_time
        )
    except Exception as e:
        return ProcessingResponse(
            success=False,
            error_message=str(e),
            processing_time=time.time() - start_time
        )
```

### Async/Await Patterns
- Use `async def` for I/O-bound operations
- Use `def` for CPU-bound or synchronous operations
- Properly handle async context managers and generators

```python
import asyncio
from contextlib import asynccontextmanager

async def fetch_data(url: str) -> Dict[str, Any]:
    """Async function for I/O operations"""
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        return response.json()

@asynccontextmanager
async def database_transaction():
    """Async context manager for database transactions"""
    transaction = await db.begin()
    try:
        yield transaction
        await transaction.commit()
    except Exception:
        await transaction.rollback()
        raise
```

## Resource Management

### Context Managers
- Use context managers (with statements) for all resources
- Implement proper cleanup in finally blocks
- Handle connection pools and file handles explicitly

```python
from contextlib import contextmanager
import tempfile
import shutil

@contextmanager
def temporary_directory():
    """Context manager for temporary directory cleanup"""
    temp_dir = tempfile.mkdtemp()
    try:
        yield temp_dir
    finally:
        shutil.rmtree(temp_dir)

# Usage
with temporary_directory() as temp_dir:
    # Work with temporary directory
    process_files_in_directory(temp_dir)
# Directory automatically cleaned up
```

### Memory Management
```python
def process_large_file_in_chunks(file_path: str, chunk_size: int = 8192) -> Iterator[bytes]:
    """Process large files in memory-efficient chunks"""
    with open(file_path, 'rb') as f:
        while chunk := f.read(chunk_size):
            yield chunk
```

## Documentation Standards

### Docstring Format
- Follow Google docstring format
- Include type information in docstrings
- Document exceptions that may be raised
- Add inline comments for complex logic

```python
def process_geospatial_data(
    input_path: str, 
    output_path: str, 
    options: Optional[ProcessingOptions] = None
) -> ProcessingResult:
    """Process geospatial data with specified options.
    
    Args:
        input_path: Path to input geospatial file
        output_path: Path where processed file will be saved
        options: Optional processing configuration
        
    Returns:
        ProcessingResult containing operation details and metrics
        
    Raises:
        FileNotFoundError: If input file doesn't exist
        ValidationError: If input file format is invalid
        ProcessingError: If processing operation fails
        
    Example:
        >>> result = process_geospatial_data(
        ...     'input.tif', 
        ...     'output.tif',
        ...     ProcessingOptions(compression='deflate')
        ... )
        >>> print(result.success)
        True
    """
    # Implementation here
    pass
```

## Configuration Management

### Environment-Based Configuration
```python
from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # Database settings
    supabase_url: str
    supabase_key: str
    
    # Processing settings
    max_concurrent_tasks: int = 2
    processing_timeout: int = 3600
    
    # Development settings
    debug_mode: bool = False
    log_level: str = "INFO"
    
    # Optional settings
    logfire_token: Optional[str] = None
    
    class Config:
        env_file = ".env"
        case_sensitive = False

# Global settings instance
settings = Settings()
```

## Testing Patterns

### Test Organization
```python
import pytest
from unittest.mock import Mock, patch
from shared.testing import create_test_dataset

class TestDatasetProcessing:
    """Test class for dataset processing functionality"""
    
    @pytest.fixture
    def sample_dataset(self):
        """Fixture providing sample dataset for tests"""
        return create_test_dataset()
    
    def test_process_valid_dataset(self, sample_dataset):
        """Test processing with valid dataset"""
        result = process_dataset(sample_dataset.id)
        assert result.success is True
    
    @pytest.mark.slow
    def test_process_large_dataset(self, large_dataset):
        """Test processing with large dataset (marked as slow)"""
        result = process_dataset(large_dataset.id)
        assert result.success is True
    
    @patch('shared.db.get_dataset')
    def test_process_nonexistent_dataset(self, mock_get_dataset):
        """Test error handling for nonexistent dataset"""
        mock_get_dataset.return_value = None
        
        with pytest.raises(DatasetNotFoundError):
            process_dataset(999)
```

## Best Practices Summary

### Code Quality
1. **Use comprehensive type hints** for all function signatures
2. **Implement error-first design** with early returns
3. **Use Pydantic models** for data validation and configuration
4. **Follow PEP 8** with project-specific formatting rules
5. **Write descriptive docstrings** with examples and error documentation

### Error Handling
1. **Create custom exception hierarchies** for domain-specific errors
2. **Use structured logging** with LogContext for all operations
3. **Implement proper resource cleanup** with context managers
4. **Distinguish between temporary and permanent errors**
5. **Include detailed error context** for debugging

### Performance
1. **Use async/await** for I/O-bound operations
2. **Process large files in chunks** to manage memory
3. **Implement proper connection pooling** for external services
4. **Use appropriate data structures** for the task
5. **Profile and optimize** critical code paths

### Maintainability
1. **Keep functions small and focused** on single responsibilities
2. **Use composition over inheritance** where possible
3. **Implement comprehensive test coverage** with appropriate markers
4. **Document complex business logic** with clear comments
5. **Use consistent naming conventions** throughout the codebase