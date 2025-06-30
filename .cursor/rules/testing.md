---
description: Testing guidelines for DeadTrees project
globs: ["**/test_*.py", "**/tests/**/*.py"]
alwaysApply: true
---

# Testing Guidelines

## Core Principle
**NEVER run pytest directly. Always use `deadtrees dev test` commands.**

## CLI Testing Commands
```bash
# Test specific services
deadtrees dev test api
deadtrees dev test processor
deadtrees dev test cli

# Debug with specific tests
deadtrees dev debug api --test-path=test_specific.py
```

## Test Environment Setup
```bash
# Reset database before testing
supabase db reset

# Run tests with fresh environment
deadtrees dev test api
```

## Debug Ports
- API: 5679
- Processor: 5678  
- CLI: 5680

## Test Environment
- Uses `docker-compose.test.yaml`
- Containerized test environment with proper isolation
- Test data managed via Makefile (download assets, create symlinks)

## Test Failure Troubleshooting

### Database-Related Test Failures
```python
# Common pattern: Trigger not firing for processor user
def test_dataset_update_with_processor_user():
    # Issue: auth.uid() returns NULL for processor
    # Solution: Check trigger handles dual authentication
    
    # Verify edit history was created
    history_response = client.table('v2_dataset_edit_history').select('*').execute()
    assert len(history_response.data) > 0  # Should not be empty
```

### Authentication Test Patterns
```python
# Test both user types
def test_regular_user_update():
    user_token = login(TEST_USER_EMAIL, TEST_USER_PASSWORD)
    # Test with auth.uid()

def test_processor_user_update():
    processor_token = login(PROCESSOR_USERNAME, PROCESSOR_PASSWORD)
    # Test with auth.jwt() email pattern
```

### Common Test Failure Causes
- **Empty result sets**: Check if triggers are firing correctly
- **Authentication errors**: Verify dual auth pattern in database functions
- **RLS policy blocks**: Ensure test users have required permissions
- **Container state**: Reset test environment between runs

### Debugging Failed Tests
```bash
# Get detailed test output
deadtrees dev test api 2>&1 | tee test_output.log

# Check container logs
docker-compose -f docker-compose.test.yaml logs api-test

# Connect to test container for debugging
docker-compose -f docker-compose.test.yaml exec api-test bash
```

## Test Structure
```python
import pytest
from shared.models import Dataset
from shared.logging import UnifiedLogger, LogContext

@pytest.fixture
def sample_dataset():
    return Dataset(id=1, name="test_dataset")

def test_process_dataset(sample_dataset):
    # Arrange
    logger = UnifiedLogger()
    context = LogContext(dataset_id=sample_dataset.id)
    
    # Act
    result = process_dataset(sample_dataset)
    
    # Assert
    assert result.success
    logger.info("Test completed", context=context)
```

## Integration Tests
- Use containerized services for realistic testing
- Test actual database connections and external APIs
- Mock external services only when necessary

## Database Testing Patterns
- Always test both regular users and processor authentication
- Verify triggers fire correctly for all user types
- Check RLS policies allow appropriate access
- Test view dependencies after schema changes 