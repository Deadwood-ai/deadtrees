#!/usr/bin/env python3
"""
Upload script for GeoNadir drone data.

This script processes GeoNadir orthophoto data and metadata from a CSV file,
uploads the datasets to the platform, and initiates processing tasks including
deadwood segmentation (tree analysis).

Usage:
    python scripts/upload_data_geonadir.py
"""

from pathlib import Path
import pandas as pd
from datetime import datetime
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
from shared.db import use_client
from shared.settings import settings

# GeoNadir data paths
ORTHOS_PATH = Path("/mnt/gsdata/projects/deadtrees/drone_campaigns/GeoNadir/orthos")
METADATA_CSV = Path("scripts/geonadir/geonadir_ortho_metada_updated_4_deadtrees.csv")

def file_exists_in_db(data_commands, filename: str) -> bool:
    """Check if a file already exists in the database
    
    Args:
        data_commands: DataCommands instance for auth token
        filename: Name of the file to check
        
    Returns:
        bool: True if file exists, False otherwise
    """
    try:
        # Get auth token from data_commands
        token = data_commands._ensure_auth()
        
        # Query the datasets table
        with use_client(token) as client:
            response = (
                client.table(settings.datasets_table)
                .select('id')
                .eq('file_name', filename)
                .execute()
            )
            return len(response.data) > 0
    except Exception as e:
        print(f"Error checking file existence: {str(e)}")
        return False

def parse_acquisition_date(date_string: str) -> tuple[int, int, int]:
    """Parse ISO format date string into year, month, day components
    
    Args:
        date_string: ISO format date string (e.g., "2017-09-14 23:03:01+00:00")
        
    Returns:
        tuple: (year, month, day) as integers
    """
    try:
        # Parse the ISO format date string
        dt = datetime.fromisoformat(date_string.replace('Z', '+00:00'))
        return dt.year, dt.month, dt.day
    except Exception as e:
        print(f"Error parsing date '{date_string}': {e}")
        # Return None values if parsing fails
        return None, None, None

def create_description(author: str, url: str) -> str:
    """Create a descriptive text for the dataset
    
    Args:
        author: Author name from deadtrees_author column
        url: GeoNadir URL for the dataset
        
    Returns:
        str: Formatted description
    """
    return (
        f"This orthophoto data was kindly contributed by GeoNadir."
        f"For more information about this dataset, please visit the original data "
        f"source at: {url}"
    )

def find_ortho_file(dataset_id: str) -> Path:
    """Find the corresponding .tif file for a dataset_id
    
    Args:
        dataset_id: Dataset ID from CSV
        
    Returns:
        Path: Path to the .tif file
        
    Raises:
        FileNotFoundError: If the .tif file doesn't exist
    """
    tif_filename = f"{dataset_id}.tif"
    tif_path = ORTHOS_PATH / tif_filename
    
    if not tif_path.exists():
        raise FileNotFoundError(f"Ortho file not found: {tif_path}")
    
    return tif_path

def main():
    """Main upload process for GeoNadir data"""
    print("Starting GeoNadir data upload process...")
    
    # Initialize DataCommands for file existence checks
    data_commands = DataCommands()
    
    # Read GeoNadir metadata CSV
    if not METADATA_CSV.exists():
        raise FileNotFoundError(f"Metadata CSV not found: {METADATA_CSV}")
    
    print(f"Reading metadata from: {METADATA_CSV}")
    df = pd.read_csv(METADATA_CSV)
    
    # Filter out rows with missing essential data
    initial_count = len(df)
    df = df.dropna(subset=['dataset_id', 'captured_date', 'deadtrees_author', 'url'])
    filtered_count = len(df)
    
    if filtered_count < initial_count:
        print(f"Filtered out {initial_count - filtered_count} rows with missing data")
    
    print(f"Processing {filtered_count} datasets...")
    
    # Track processing results
    processed_files = []
    failed_files = []
    skipped_files = []
    processing_failed = []
    
    # Process each dataset
    for _, row in tqdm(df.iterrows(), total=len(df), desc="Processing datasets"):
        dataset_id = str(row['dataset_id'])
        
        try:
            # Find the corresponding ortho file
            ortho_file = find_ortho_file(dataset_id)
            filename = ortho_file.name
            
            # Check if file already exists in database
            if file_exists_in_db(data_commands, filename):
                print(f"Skipping {filename} - already exists in database")
                skipped_files.append(filename)
                continue
            
            # Parse acquisition date
            year, month, day = parse_acquisition_date(row['captured_date'])
            if year is None:
                print(f"Warning: Could not parse date for {filename}, skipping...")
                failed_files.append(filename)
                continue
            
            # Prepare metadata
            author = str(row['deadtrees_author']).strip()
            url = str(row['url']).strip()
            description = create_description(author, url)
            
            # Create new DataCommands instance for each upload to ensure fresh token
            upload_data_commands = DataCommands()
            
            print(f"\nUploading {filename} by {author}...")
            
            # Upload the dataset
            result = upload_data_commands.upload(
                file_path=str(ortho_file),
                authors=[author],  # Convert to list as required by API
                platform="drone",  # GeoNadir data is from drones
                license="CC BY",   # Default license, adjust as needed
                data_access="public",  # Making data publicly accessible
                aquisition_year=year,
                aquisition_month=month,
                aquisition_day=day,
                additional_information=description,
                citation_doi=url,  # Using GeoNadir URL as DOI reference
            )
            
            if result:
                dataset_id_result = result['id']
                print(f"Successfully uploaded {filename} with dataset ID: {dataset_id_result}")
                
                # Start processing tasks including deadwood (tree analysis)
                try:
                    process_result = upload_data_commands.process(
                        dataset_id=dataset_id_result,
                        task_types=[
                            'geotiff',    # Convert to geotiff format
                            'metadata',   # Extract metadata
                            'cog',        # Generate cloud optimized geotiff
                            'thumbnail',  # Generate thumbnail
                            'deadwood'    # Run deadwood/tree segmentation analysis
                        ],
                        priority=2    # Standard priority
                    )
                    print(f"Started processing tasks for dataset {dataset_id_result}")
                    processed_files.append(filename)
                    
                except Exception as e:
                    print(f"Error starting processing for {dataset_id_result}: {str(e)}")
                    processing_failed.append((filename, dataset_id_result))
            else:
                print(f"Failed to upload {filename}")
                failed_files.append(filename)
                
        except FileNotFoundError as e:
            print(f"File not found for dataset {dataset_id}: {e}")
            failed_files.append(f"{dataset_id}.tif")
            continue
        except Exception as e:
            print(f"Error processing dataset {dataset_id}: {str(e)}")
            failed_files.append(f"{dataset_id}.tif")
            continue
    
    # Print summary
    print("\n" + "="*60)
    print("GEONADIR UPLOAD SUMMARY")
    print("="*60)
    print(f"Successfully processed:        {len(processed_files)} files")
    print(f"Failed uploads:               {len(failed_files)} files")
    print(f"Failed processing starts:     {len(processing_failed)} files")
    print(f"Skipped (already exists):     {len(skipped_files)} files")
    print(f"Total processed:              {len(processed_files) + len(failed_files) + len(skipped_files)}")
    
    # Save failed files for later investigation
    if failed_files:
        failed_file_path = 'failed_uploads_geonadir.txt'
        with open(failed_file_path, 'w') as f:
            for file in failed_files:
                f.write(f"{file}\n")
        print(f"\nFailed uploads saved to: {failed_file_path}")
    
    if processing_failed:
        processing_failed_path = 'failed_processing_geonadir.txt'
        with open(processing_failed_path, 'w') as f:
            for file, dataset_id in processing_failed:
                f.write(f"{file},{dataset_id}\n")
        print(f"Failed processing starts saved to: {processing_failed_path}")
    
    print("\nGeoNadir upload process completed!")

if __name__ == "__main__":
    main()
