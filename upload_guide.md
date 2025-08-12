# DeadTrees Upload Guide

Quick guide for researchers to upload drone orthophoto data to the DeadTrees platform for automated forest analysis.

## What You Get

- **Automated tree cover analysis** using AI segmentation
- **Deadwood detection** for forest health monitoring  
- **Cloud-optimized formats** (COG) for web visualization
- **Metadata extraction** and geospatial processing

## Setup

### 1. Install CLI Package

```bash
git clone https://github.com/deadtrees/deadwood-api.git
cd deadwood-api/deadtrees-cli
pip install -e .
```

### 2. Environment Setup

Create `.env` file:
```bash
# Your credentials (NOT processor credentials)
PROCESSOR_USERNAME=your_email@university.edu
PROCESSOR_PASSWORD=your_secure_password

# Platform access
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
API_ENDPOINT=https://data2.deadtrees.earth/api/v1/
```

### 3. Create Upload Script

Save this as `upload_your_data.py`:

```python
#!/usr/bin/env python3
import os
from pathlib import Path
import pandas as pd
from datetime import datetime
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
from shared.db import use_client
from shared.settings import settings

# Configure these paths for your data
ORTHOS_PATH = Path('your_orthos/')
METADATA_CSV = Path('your_metadata.csv')

# Progress tracking files
PROCESSED_FILE = Path('processed_uploads.txt')
FAILED_FILE = Path('failed_uploads.txt')

def load_processed_files():
    """Load already processed files to enable resuming"""
    if PROCESSED_FILE.exists():
        with open(PROCESSED_FILE, 'r') as f:
            return set(line.strip() for line in f)
    return set()

def mark_as_processed(filename):
    """Track successful uploads"""
    with open(PROCESSED_FILE, 'a') as f:
        f.write(f'{filename}\n')

def mark_as_failed(filename, reason):
    """Track failed uploads"""
    with open(FAILED_FILE, 'a') as f:
        f.write(f'{filename}: {reason}\n')

def file_exists_in_db(data_commands, filename):
    """Check if file already exists (prevents duplicates)"""
    try:
        token = data_commands._ensure_auth()
        with use_client(token) as client:
            response = client.table(settings.datasets_table).select('id').eq('file_name', filename).execute()
            return len(response.data) > 0
    except Exception as e:
        print(f'Error checking file existence: {str(e)}')
        return False

def main():
    print('Starting upload process...')
    
    # Load progress
    processed_files = load_processed_files()
    data_commands = DataCommands()
    
    # Read your metadata
    df = pd.read_csv(METADATA_CSV)
    
    # Counters
    successful = 0
    failed = 0
    skipped = 0
    
    # Process each dataset
    for _, row in tqdm(df.iterrows(), total=len(df)):
        filename = f"{row['dataset_id']}.tif"
        ortho_file = ORTHOS_PATH / filename
        
        # Skip if already processed
        if filename in processed_files:
            print(f'Skipping {filename} - already processed')
            skipped += 1
            continue
            
        # Skip if file doesn't exist
        if not ortho_file.exists():
            print(f'File not found: {ortho_file}')
            mark_as_failed(filename, 'File not found')
            failed += 1
            continue
        
        # Skip if already in database
        if file_exists_in_db(data_commands, filename):
            print(f'Skipping {filename} - already in database')
            mark_as_processed(filename)
            skipped += 1
            continue
        
        try:
            # Parse acquisition date
            dt = datetime.fromisoformat(row['captured_date'])
            
            # Upload dataset
            result = data_commands.upload(
                file_path=str(ortho_file),
                authors=[row['author']],
                platform='drone',
                license='CC BY',
                data_access='public',  # or 'private'
                aquisition_year=dt.year,
                aquisition_month=dt.month,
                aquisition_day=dt.day,
                additional_information=f"Data from {row.get('institution', 'Research Institution')}",
                citation_doi=row.get('url', None),
            )
            
            if result:
                dataset_id = result['id']
                print(f"✓ Uploaded: {filename} (ID: {dataset_id})")
                
                # Start processing
                data_commands.process(
                    dataset_id=dataset_id,
                    task_types=['geotiff', 'metadata', 'cog', 'thumbnail', 'deadwood', 'treecover'],
                    priority=2
                )
                
                mark_as_processed(filename)
                successful += 1
            else:
                mark_as_failed(filename, 'Upload failed')
                failed += 1
                
        except Exception as e:
            print(f'Error with {filename}: {str(e)}')
            mark_as_failed(filename, str(e))
            failed += 1
    
    # Summary
    print(f'\n=== UPLOAD SUMMARY ===')
    print(f'Successful: {successful}')
    print(f'Failed: {failed}')
    print(f'Skipped: {skipped}')
    
    if failed > 0:
        print(f'\nCheck {FAILED_FILE} for error details')

if __name__ == '__main__':
    main()
```


### 4. Prepare Your Data

**File structure:**
```
your_project/
├── .env
├── upload_your_data.py
├── your_orthos/
│   ├── dataset_001.tif
│   └── dataset_002.tif
└── your_metadata.csv
```

**Metadata CSV format:**
```csv
dataset_id,captured_date,author,institution,url
dataset_001,2023-06-15T10:30:00+00:00,Dr. Smith,Forest University,https://doi.org/10.example/123
dataset_002,2023-06-16T14:20:00+00:00,Dr. Jones,Forest University,https://doi.org/10.example/124
```

## Usage

```bash
# Run upload (resumable)
python upload_your_data.py

# If it fails, fix issues and re-run - it will skip completed files
python upload_your_data.py
```

## Data Requirements

- **Format**: GeoTIFF (`.tif`) with spatial reference
- **Resolution**: 5-10cm ground sampling distance preferred
- **Size**: Up to several GB per file (automatic chunking)
- **Coordinates**: Any EPSG code (automatically standardized)

## Key Features

- ✅ **Resumable uploads** - Skip completed files on restart
- ✅ **Duplicate detection** - Won't re-upload existing files  
- ✅ **Progress tracking** - `processed_uploads.txt` and `failed_uploads.txt`
- ✅ **Error handling** - Detailed failure logging
- ✅ **Automatic processing** - AI analysis starts after upload

## Security Notes

- Uses **regular user credentials** (much safer than admin access)
- You can only see/modify your own data + public datasets

## Getting Help

- **Setup issues**: Verify credentials and network access
- **Upload errors**: Check `failed_uploads.txt` for details
- **Large datasets**: Contact team for bulk upload strategies

---

**Contact the DeadTrees team to get your credentials and start contributing your forest monitoring data!**
