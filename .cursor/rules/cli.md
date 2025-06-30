---
description: CLI development patterns for DeadTrees project
globs: ["deadtrees-cli/**/*.py"]
alwaysApply: true
---

# CLI Guidelines

## Core Framework
- Uses Python Fire for command structure
- Entry point: `deadtrees` command
- Modular command structure with grouped functionality

## Development Commands
```bash
# Environment management
deadtrees dev start        # Start development environment
deadtrees dev stop         # Stop environment
deadtrees dev test api     # Test API service
deadtrees dev debug api    # Debug API with breakpoints

# Data operations
deadtrees data upload      # Upload datasets
deadtrees data process     # Process datasets
deadtrees data download    # Download results
```

## Command Structure
```python
import fire
from shared.logging import UnifiedLogger

class DataCommands:
    def __init__(self):
        self.logger = UnifiedLogger()
    
    def upload(self, file_path: str, user_id: str) -> bool:
        """Upload a dataset file."""
        # Error handling first
        if not os.path.exists(file_path):
            self.logger.error(f"File not found: {file_path}")
            return False
        
        # Process upload
        result = self._upload_file(file_path, user_id)
        return result.success

if __name__ == '__main__':
    fire.Fire(DataCommands)
```

## Asset Management
- Use Makefile for asset downloads: `make download-assets`
- Create symlinks for legacy test data: `make symlinks`
- Assets stored in `assets/` directory

## Error Handling
- Return boolean success indicators
- Use structured logging for all operations
- Handle CLI interruption gracefully 