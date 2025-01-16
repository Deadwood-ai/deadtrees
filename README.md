# Deadwood API

Main FastAPI application for the deadwood backend. This repository contains both the API and processor components for processing geospatial data and performing deadwood segmentation.

## Prerequisites

- Docker and Docker Compose
- NVIDIA GPU with CUDA support (for deadwood segmentation)

---

## Setup

### Clone the repository with submodules:

```bash
# Clone the repository
git clone https://github.com/deadtrees/deadwood-api.git
cd deadwood-api

# Initialize and update submodules
git submodule update --init --recursive

```

### Create a .env file with required environment variables:

```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
PROCESSOR_PASSWORD=your_processor_password
STORAGE_SERVER_USERNAME=your_username
SSH_PRIVATE_KEY_PATH=/path/to/your/ssh/key
STORAGE_SERVER_DATA_PATH=/apps/storage-server/production
DEV_MODE=true
LOGFIRE_TOKEN=your_logfire_token
```

### Download required assets:

```bash
# Create assets directory and download test data, models, and GADM data
make
```

### Use the CLI tool to manage the development environment:

```bash
# Start the development environment
./dtool.py up

# Stop the development environment
./dtool.py down

# Run API tests
./dtool.py test test-api api/tests/routers/test_download.py

# Debug API testsj
./dtool.py debug test-api api/tests/routers/test_download.py
```

### Run the application with Docker Compose:

```bash
# Build and run all tests
docker compose -f docker-compose.test.yaml up --build

# Run specific test suites
docker compose -f docker-compose.test.yaml run processor-test pytest processor/tests/
docker compose -f docker-compose.test.yaml run api-test pytest api/tests/
```

### Local supabase setup and development

```bash
# Start Supabase
supabase login

# Initialize project
supabase init

# Link to project
supabase link --project-ref <project-ref>

# Start Supabase
supabase start

# Create initial migration file
# supabase db diff --use-migra initial_schema -f initial_schema --linked
supabase db pull

# Apply the migration
supabase migration up

# to reset the database
supabase db reset

# set new env varialbes based on the output of supabase start
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key

```

## Project structure

```bash
/assets      - Downloaded data and models
  /gadm        - GADM geographic data
  /models      - ML models for deadwood segmentation
/test_data   - Test GeoTIFF files

/api         - FastAPI application
  /src       - Source code
  /tests     - API tests

/processor   - Data processing service
  /src       - Source code
  /tests     - Processor tests

/shared      - Shared code between API and processor
```
