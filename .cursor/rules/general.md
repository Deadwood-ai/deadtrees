---
description: General project structure and shared patterns
alwaysApply: true
---

# General Guidelines

## Project Structure
```
├── api/                    # FastAPI backend service
├── processor/              # Data processing pipeline  
├── deadtrees-cli/          # CLI tools and development commands
├── shared/                 # Common utilities and models
├── supabase/              # Database migrations and config
├── .cursor/rules/         # Modular configuration rules
└── docker-compose.*.yaml  # Environment-specific orchestration
```

## Debugging and Troubleshooting

### Development Workflow
```bash
# Reset test database and run tests
supabase db reset
deadtrees dev test api

# Debug specific test with detailed output
deadtrees dev debug api --test-path=specific_test.py

# Check database migration status
supabase migration list --db-url 'postgresql://...:5432/postgres'
```

### Common Error Patterns

#### Database Connection Issues
- **Connection pooler errors**: Switch from port 6543 to 5432 for migrations
- **Prepared statement conflicts**: Use direct connection for administrative operations
- **Authentication failures**: Check dual auth pattern (processor vs regular users)

#### Migration Problems
- **View dependency errors**: Drop views before altering referenced columns
- **Column type conflicts**: Ensure migration sequence handles dependencies
- **Missing objects**: Include complete definitions in migration files

#### Test Failures
- **Trigger not firing**: Check authentication handling in database functions
- **RLS policy blocks**: Verify processor user has appropriate permissions
- **Container issues**: Ensure test environment is properly reset

### Error Code Quick Reference
- **SQLSTATE 42P05**: Prepared statement exists → Use direct connection
- **SQLSTATE 0A000**: View dependency conflict → Drop/recreate views
- **SQLSTATE 42703**: Column missing → Check migration order
- **Exit code 1 (tests)**: Check test logs for specific failure patterns

### Debugging Commands
```bash
# Database debugging
supabase migration up --debug --db-url 'postgresql://...:5432/postgres'
supabase db reset  # Reset local development database

# Test debugging  
deadtrees dev test api  # Run all API tests
deadtrees dev debug api --test-path=path/to/test.py  # Debug specific test

# Container debugging
docker-compose -f docker-compose.test.yaml logs api-test
docker-compose -f docker-compose.test.yaml exec api-test bash
```

## Shared Code Conventions
- Use `shared/` for code shared between services
- Common models in `shared/models.py`
- Unified logging in `shared/logging.py`
- Settings management in `shared/settings.py`

## Environment Detection
```python
import os

ENV = os.getenv('ENV', 'development')
IS_DEVELOPMENT = ENV == 'development'
DEV_MODE = IS_DEVELOPMENT  # Legacy compatibility
```

## File Naming
- Use lowercase with underscores: `user_routes.py`
- Descriptive names that indicate purpose
- Consistent naming across services

## Project Structure & Shared Code Guidelines

## Project Architecture Overview

```
├── api/                    # FastAPI backend service
│   ├── src/               # API source code
│   ├── tests/             # API unit tests
│   ├── Dockerfile         # API service containerization
│   └── requirements.txt   # API-specific dependencies

├── processor/              # Data processing service
│   ├── src/               # Processing logic source code
│   ├── tests/             # Processor unit tests
│   ├── Dockerfile         # Processor container definition
│   └── requirements.txt   # Processor dependencies

├── deadtrees-cli/          # Command Line Interface package
│   ├── deadtrees_cli/     # CLI source code
│   ├── tests/             # CLI unit tests
│   └── setup.py           # CLI package configuration

├── shared/                 # Shared utilities and models
│   ├── models.py          # Shared data models
│   ├── settings.py        # Global settings management
│   ├── db.py              # Database connection handling
│   ├── logging.py         # Unified logging system
│   ├── hash.py            # Hashing utilities
│   ├── labels.py          # Label management
│   ├── ortho.py           # Orthographic processing
│   ├── status.py          # Status tracking
│   ├── utils.py           # Common utilities
│   ├── monitoring.py      # System monitoring
│   └── testing/           # Shared test utilities

├── assets/                 # Static and reference data
│   ├── test_data/         # Test datasets
│   ├── models/            # ML/AI model files
│   ├── gadm/              # Geographic administrative data
│   └── biom/              # Biometric data assets

├── data/                   # Data storage directories
│   ├── archive/           # Historical/archived data
│   ├── cogs/              # Cloud Optimized GeoTIFFs
│   ├── downloads/         # Downloaded raw data
│   ├── label_objects/     # Labeled training data
│   ├── processing_dir/    # Temporary processing workspace
│   ├── thumbnails/        # Image thumbnails
│   └── trash/             # Soft-deleted items

├── supabase/              # Database management
│   ├── config.toml        # Supabase configuration
│   └── migrations/        # Database migrations

├── nginx/                 # Reverse proxy and load balancer
│   ├── api-conf/          # Production nginx config
│   ├── test-conf/         # Test environment config
│   └── entrypoint.sh      # Container startup script

├── end2end_tests/         # Integration/E2E testing
│   ├── src/               # Test source code
│   ├── Dockerfile         # Test environment container
│   └── requirements.txt   # Test dependencies

├── scripts/               # Utility and maintenance scripts
│   ├── debug_cog_processing.py
│   ├── upload_data.py
│   └── issues/            # Issue-specific scripts

├── .cursor/rules/         # Modular configuration rules
│   ├── python.md          # Python coding standards
│   ├── fastapi.md         # FastAPI patterns
│   ├── testing.md         # Testing strategies
│   ├── docker.md          # Container orchestration
│   ├── database.md        # Database operations
│   ├── cli.md             # CLI patterns
│   ├── monitoring.md      # Logging and monitoring
│   └── data-processing.md # Processing pipeline

└── docker-compose.*.yaml  # Environment-specific orchestration
    ├── docker-compose.api.yaml        # Production API
    ├── docker-compose.processor.yaml  # Production processor
    └── docker-compose.test.yaml       # Development/testing
```

## Core Components

### 1. API Service (`./api`)
- **Purpose**: FastAPI-based REST API for client interactions
- **Responsibilities**: Request handling, data serving, user authentication
- **Technology**: FastAPI, Pydantic, async/await patterns
- **Deployment**: Containerized service with nginx reverse proxy

### 2. Data Processor (`./processor`)
- **Purpose**: Heavy data processing tasks (geospatial, ML inference)
- **Responsibilities**: Image processing, deadwood segmentation, metadata extraction
- **Technology**: GPU-accelerated containers, GDAL, PyTorch
- **Deployment**: Separate containerized service with GPU support

### 3. CLI Tools (`./deadtrees-cli`)
- **Purpose**: Development environment management and data operations
- **Responsibilities**: Testing, debugging, data upload/processing
- **Technology**: Python Fire, Docker Compose integration
- **Usage**: Primary interface for development workflow

### 4. Shared Code (`./shared`)
- **Purpose**: Common utilities used across all services
- **Responsibilities**: Database interfaces, logging, models, settings
- **Technology**: Pydantic models, Supabase client, structured logging
- **Integration**: Imported by API, processor, and CLI

## Shared Code Conventions

### Module Organization
```python
# shared/models.py - Core data models
from pydantic import BaseModel
from typing import Optional, List

class Dataset(BaseModel):
    id: int
    file_name: str
    user_id: str
    created_at: datetime
    
# shared/settings.py - Global configuration
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    supabase_url: str
    supabase_key: str
    # Environment-specific table access
    
# shared/db.py - Database utilities
async def get_supabase_client():
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
```

### Import Patterns
```python
# Services import shared modules using absolute imports
from shared.models import Dataset, ProcessingStatus
from shared.settings import settings
from shared.logging import UnifiedLogger, LogContext, LogCategory
from shared.db import get_supabase_client
```

### Dependency Management
- **Minimize external dependencies** in shared code
- **Document required dependencies** clearly in each service
- **Use consistent versions** across all services (via requirements.txt)
- **Handle circular dependencies** carefully

### Usage Guidelines
- **Import shared utilities** using absolute imports
- **Don't modify shared code** without cross-service testing
- **Keep backwards compatibility** in mind for shared interfaces
- **Document breaking changes** in shared modules
- **Version shared components** carefully

## Environment Management

### Development Workflow
```bash
# Primary development commands (via CLI)
deadtrees dev start         # Start test environment
deadtrees dev test api      # Run API tests
deadtrees dev debug api     # Debug API tests
deadtrees dev stop          # Stop environment
```

### Environment-Specific Configuration
- **Development**: `docker-compose.test.yaml` - Full test environment
- **Production API**: `docker-compose.api.yaml` - API + nginx + certbot
- **Production Processor**: `docker-compose.processor.yaml` - GPU processing

### Data Management
- **Test Data**: Managed via Makefile (`make download-assets`)
- **Production Data**: Persistent volumes mounted to `/data`
- **Asset Symlinks**: Legacy support via `make symlinks`

## Database Schema Organization

### Table Versioning
```python
# shared/settings.py
_tables = {
    'datasets': 'v2_datasets',      # Current production
    'labels': 'v2_labels',
    'cogs': 'v2_cogs',
    # ... other v2 tables
}

# Legacy tables (v1_*, dev_*) maintained for backward compatibility
```

### Migration Management
- **Supabase CLI**: Generate and apply migrations
- **Version Control**: All migrations tracked in `supabase/migrations/`
- **Environment Sync**: Consistent schema across dev/prod

## Configuration Management

### Settings Hierarchy
1. **Environment Variables** (highest priority)
2. **`.env` files** (development)
3. **Default values** in Settings classes
4. **Container environment** (production)

### Environment Detection
```python
# Automatic environment detection
ENV = os.getenv('ENV', 'development')
IS_DEVELOPMENT = ENV == 'development'

# Environment-specific behavior
API_ENDPOINT = 'http://localhost:8080/api/v1/' if DEV_MODE else 'https://data2.deadtrees.earth/api/v1/'
```

## Asset and Data Flow

### Asset Management
```bash
# Download and setup assets
make download-assets        # Test data, models, GADM data
make symlinks              # Create legacy symlinks
make clean                 # Clean downloaded assets
```

### Data Processing Flow
```
1. Upload → API service → Database record
2. Queue → Processor picks up → Sequential processing
3. Results → Storage server → Database metadata
4. Cleanup → Temporary files removed
```

### File Organization
- **Input**: Raw orthophotos in various formats
- **Processing**: Temporary directory per dataset
- **Output**: COGs, thumbnails, segmentation results, metadata
- **Storage**: Organized by type (cogs/, thumbnails/, etc.)

## Service Communication

### Inter-Service Architecture
- **API ↔ Database**: Direct Supabase connection
- **Processor ↔ Database**: Queue-based processing
- **Processor ↔ Storage**: SSH file transfers
- **CLI ↔ Services**: Docker Compose orchestration

### Data Consistency
- **Database transactions** for multi-table operations
- **Status tracking** throughout processing pipeline
- **Error recovery** with proper cleanup
- **Audit logging** for all operations

## Best Practices

### Shared Code Development
1. **Keep shared code minimal** and focused on core functionality
2. **Document all shared functions** thoroughly with examples
3. **Use semantic versioning** for breaking changes
4. **Test shared code** across all consuming services
5. **Maintain backward compatibility** whenever possible

### Project Organization
1. **Follow consistent naming** conventions across all services
2. **Use environment-specific configurations** for different deployments
3. **Implement proper separation** of concerns between services
4. **Document service interactions** and data flows
5. **Maintain clear boundaries** between service responsibilities

### Development Workflow
1. **Use CLI commands** for all development tasks
2. **Test changes** in containerized environments
3. **Follow database migration** procedures for schema changes
4. **Update documentation** when adding new features
5. **Coordinate changes** that affect multiple services









