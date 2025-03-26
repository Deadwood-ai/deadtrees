from pathlib import Path
import pandas as pd
from deadtrees_cli.data import DataCommands
from tqdm import tqdm
from shared.db import use_client
from shared.settings import settings

# Database path configuration
DATABASE_PATH = Path("/net/tree_mortality_orthophotos/")

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

def get_data_access(is_public: bool) -> str:
    """Convert boolean public flag to data access string
    
    Args:
        is_public: Boolean indicating if data is public
        
    Returns:
        str: 'public' if True, 'private' if False
    """
    return "public" if is_public else "private"

def main():
    # Initialize DataCommands once for file existence checks
    data_commands = DataCommands()
    
    # Read database metadata
    df = pd.read_csv(
        DATABASE_PATH / "metadata_manual.copy.csv",
        dtype={
            "public": bool,
            "has_label": bool
        }
    )
    
    # Filter out rows where acquisition_date_year is not a number
    df = df[~pd.isna(df["acquisition_date_year"])]
    # Convert acquisition year to int
    df["acquisition_date_year"] = df["acquisition_date_year"].astype(int)
    
    # Keep track of processed files
    processed_files = []
    failed_files = []
    skipped_files = []
    processing_failed = []
    
    # Process each row
    for _, row in tqdm(df.iterrows(), total=df.shape[0]):
        # Create new DataCommands instance for each row to ensure fresh token
        row_data_commands = DataCommands()
        
        # Determine file path
        if row["has_labels"]:
            file_path = DATABASE_PATH / "orthophotos" / row["filename"]
        else:
            file_path = DATABASE_PATH / "unlabeled_orthophotos" / row["project_id"] / row["filename"]
            
        # Check if file already exists in database
        if file_exists_in_db(data_commands, file_path.name):
            print(f"Skipping {file_path.name} - already exists in database")
            skipped_files.append(file_path.name)
            continue
            
        try:
            # Upload the dataset with metadata using fresh instance
            result = row_data_commands.upload(
                file_path=str(file_path),
                authors=row["authors_image"],
                platform=row["image_platform"],
                license=row["license"],
                data_access=get_data_access(row["public"]),
                aquisition_year=int(row["acquisition_date_year"]),
                aquisition_month=int(row["acquisition_date_month"]) if pd.notna(row["acquisition_date_month"]) else None,
                aquisition_day=int(row["acquisition_date_day"]) if pd.notna(row["acquisition_date_day"]) else None,
                additional_information=row["additional_information"] if pd.notna(row["additional_information"]) else None,
                citation_doi=row["citation_doi"] if pd.notna(row["citation_doi"]) else None,
            )
            
            if result:
                dataset_id = result['id']
                print(f"Successfully uploaded {file_path} with dataset ID: {dataset_id}")
                
                # Start processing tasks with same instance
                try:
                    process_result = row_data_commands.process(
                        dataset_id=dataset_id,
                        task_types=['geotiff', 'metadata', 'cog', 'thumbnail']
                    )
                    print(f"Started processing tasks for dataset {dataset_id}")
                    processed_files.append(file_path.name)
                except Exception as e:
                    print(f"Error starting processing for {dataset_id}: {str(e)}")
                    processing_failed.append((file_path.name, dataset_id))
            else:
                print(f"Failed to upload {file_path}")
                failed_files.append(file_path.name)
                
        except Exception as e:
            print(f"Error processing {file_path}: {str(e)}")
            failed_files.append(file_path.name)
            continue
    
    # Print summary
    print("\nUpload Summary:")
    print(f"Successfully processed: {len(processed_files)} files")
    print(f"Failed uploads: {len(failed_files)} files")
    print(f"Failed processing starts: {len(processing_failed)} files")
    print(f"Skipped (already exists): {len(skipped_files)} files")
    
    # Save failed files to resume later if needed
    if failed_files:
        with open('failed_uploads.txt', 'w') as f:
            for file in failed_files:
                f.write(f"{file}\n")
        print("\nFailed uploads have been saved to 'failed_uploads.txt'")
    
    if processing_failed:
        with open('failed_processing.txt', 'w') as f:
            for file, dataset_id in processing_failed:
                f.write(f"{file},{dataset_id}\n")
        print("\nFailed processing starts have been saved to 'failed_processing.txt'")

if __name__ == "__main__":
    main() 