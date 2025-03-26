from pathlib import Path
import pandas as pd
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
import geopandas as gpd
from shared.settings import settings
from shared.db import use_client
from shared.models import LabelSourceEnum, LabelTypeEnum, LabelDataEnum

# Database path configuration
DATABASE_PATH = Path("/net/tree_mortality_orthophotos/")
# File to track processed labels
PROCESSED_LABELS_FILE = Path("processed_labels_and_aois.txt")

def load_processed_files() -> set:
    """Load the set of already processed files from disk
    
    Returns:
        set: Set of filenames that have already been processed
    """
    if PROCESSED_LABELS_FILE.exists():
        with open(PROCESSED_LABELS_FILE, 'r') as f:
            return set(line.strip() for line in f)
    return set()

def get_dataset_id(data_commands, filename: str) -> int:
    """Get the dataset ID for a given orthophoto filename
    
    Args:
        filename: Name of the orthophoto file
        
    Returns:
        int: Dataset ID
    """
    token = data_commands._ensure_auth()
    with use_client(token) as client:
        response = (
            client.table(settings.datasets_table)
            .select('id')
            .eq('file_name', filename)
            .execute()
        )
        if len(response.data) == 0:
            return None
        else:
            return response.data[0]['id']
    

def mark_as_processed(filename: str):
    """Mark a file as successfully processed by appending to the processed files list
    
    Args:
        filename: Name of the file that was processed
    """
    with open(PROCESSED_LABELS_FILE, 'a') as f:
        f.write(f"{filename}\n")

def get_label_files(filename: str) -> Path:
    """Get the path to the label files for a given orthophoto filename
    
    Args:
        filename: Name of the orthophoto file
        
    Returns:
        Path: Path to the label GeoPackage file
    """
    return DATABASE_PATH / "labels_and_aois" / filename.replace(".tif", "_polygons.gpkg")

def main():
    # Initialize DataCommands
    data_commands = DataCommands()
    
    # Read database metadata
    df = pd.read_csv(
        DATABASE_PATH / "metadata_manual.copy.csv",
        dtype={
            "public": bool,
            "has_labels": bool
        }
    )
    
    # Filter only rows with labels
    df = df[df["has_labels"]]
    
    # Load set of already processed files
    processed_files = load_processed_files()
    
    # Keep track of failed files
    failed_files = []
    skipped_files = []
    
    # Process each row
    for _, row in tqdm(df.iterrows(), total=df.shape[0]):
        # Skip if already processed
        if row["filename"] in processed_files:
            print(f"Skipping {row['filename']} - already processed")
            skipped_files.append(row["filename"])
            continue
            
        # Create new DataCommands instance for each row to ensure fresh token
        row_data_commands = DataCommands()
        
        # Get label file path
        label_path = get_label_files(row["filename"])
        
        if not label_path.exists():
            print(f"Skipping {row['filename']} - label file not found")
            skipped_files.append(row["filename"])
            continue
        
        dataset_id = get_dataset_id(row_data_commands, row["filename"])
        if dataset_id is None:
            print(f"Skipping {row['filename']} - dataset ID not found")
            skipped_files.append(row["filename"])
            continue
            
        try:
            # Upload the label using upload_label_from_gpkg
            result = row_data_commands.upload_label_from_gpkg(
                dataset_id=dataset_id,
                gpkg_path=str(label_path),
                label_source=row["label_source"],
                label_type=row["label_type"],
                label_data="deadwood",  # Assuming all labels are deadwood
                label_quality=row["label_quality"],
                labels_layer="standing_deadwood",  # Default layer names
                aoi_layer="aoi",
            )
            
            if result:
                print(f"Successfully uploaded labels for {row['filename']}")
                # Mark as processed immediately after successful upload
                mark_as_processed(row["filename"])
            else:
                print(f"Failed to upload labels for {row['filename']}")
                failed_files.append(row["filename"])
                
        except Exception as e:
            print(f"Error processing labels for {row['filename']}: {str(e)}")
            failed_files.append(row["filename"])
            continue
    
    # Print summary
    print("\nLabel Upload Summary:")
    print(f"Successfully processed: {len(processed_files)} files")
    print(f"Failed uploads: {len(failed_files)} files")
    print(f"Skipped (already processed or missing files): {len(skipped_files)} files")
    
    # Save failed files to resume later if needed
    if failed_files:
        with open('failed_label_uploads.txt', 'w') as f:
            for file in failed_files:
                f.write(f"{file}\n")
        print("\nFailed uploads have been saved to 'failed_label_uploads.txt'")

if __name__ == "__main__":
    main()