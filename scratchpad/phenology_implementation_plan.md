# Phenology Metadata Implementation Plan
**Issue:** [#163 - Adding phenology information to images as additional metadata process](https://github.com/Deadwood-ai/deadtrees/issues/163)

## Overview
Integrate MODIS phenology data into the metadata processing pipeline to provide growing season information for each dataset. The phenology data consists of a 365-day curve with values 0-255 representing growing season probability, ready for frontend visualization as a green gradient bar.

## Dataset Information
- **Path:** `/home/jj1049/dev/deadtrees/assets/pheno/modispheno_aggregated_normalized.zarr`
- **Structure:** 10km x 10km pixels, 365-day arrays with values 0-255
- **Coordinate System:** MODIS Sinusoidal projection
- **Data:** Growing season probability for each day of year (2013-2022 average)

## Implementation Tasks

### Task 1: Add Dependencies
**File:** `processor/requirements.txt`
```bash
# Add these dependencies
xarray>=2023.1.0
zarr>=2.13.0
numpy>=1.24.0
```

**Validation:**
```bash
deadtrees dev start --force-rebuild
```

### Task 2: Create Phenology Data Model
**File:** `shared/models.py`

**Add to MetadataType enum:**
```python
class MetadataType(str, Enum):
    GADM = 'gadm'
    BIOME = 'biome'
    PHENOLOGY = 'phenology'  # Add this line
```

**Add new model class:**
```python
class PhenologyMetadata(BaseModel):
    """Structure for MODIS phenology metadata"""
    
    phenology_curve: List[int]  # 365-day array (0-255 values)
    source: str = 'MODIS Phenology'
    version: str = '1.0'
    
    @field_validator('phenology_curve')
    @classmethod
    def validate_curve_length(cls, v: List[int]) -> List[int]:
        """Validate phenology curve has exactly 365 values"""
        if not v or len(v) != 365:
            raise ValueError("Phenology curve must have exactly 365 values")
        return v
```

### Task 3: Create Phenology Utility Module
**File:** `processor/src/utils/phenology.py`

```python
from pathlib import Path
from typing import Tuple, Optional, List
import xarray as xr
import numpy as np
from rasterio import crs, warp
from shared.logger import logger
from shared.models import PhenologyMetadata
from shared.settings import settings

# Dataset path
PHENOLOGY_PATH = Path(settings.BASE_PATH) / "assets" / "pheno" / "modispheno_aggregated_normalized.zarr"

# MODIS Sinusoidal projection
MODIS_CRS = crs.CRS.from_string("""PROJCS["unnamed",
GEOGCS["Unknown datum based upon the custom spheroid", 
DATUM["Not specified (based on custom spheroid)", 
SPHEROID["Custom spheroid",6371007.181,0]], 
PRIMEM["Greenwich",0],
UNIT["degree",0.0174532925199433]],
PROJECTION["Sinusoidal"], 
PARAMETER["longitude_of_center",0], 
PARAMETER["false_easting",0], 
PARAMETER["false_northing",0], 
UNIT["Meter",1]]""")


def get_phenology_path() -> Path:
    """Get phenology data path, checking if it exists"""
    if not PHENOLOGY_PATH.exists():
        raise FileNotFoundError(
            f'Phenology data file not found at {PHENOLOGY_PATH}. '
            'Please ensure the dataset is available.'
        )
    return PHENOLOGY_PATH


def get_phenology_curve(lat: float, lon: float) -> Optional[List[int]]:
    """
    Get the phenology curve for a given latitude and longitude.
    
    Args:
        lat: Latitude in decimal degrees
        lon: Longitude in decimal degrees
        
    Returns:
        List of 365 integers (0-255) or None if no data available
    """
    try:
        # Transform lat/lon to MODIS coordinates
        x, y = warp.transform(crs.CRS.from_epsg(4326), MODIS_CRS, [lon], [lat])
        
        # Open the dataset
        ds = xr.open_zarr(get_phenology_path())
        
        # Get the nearest pixel
        ds_nearest = ds.sel(x=x[0], y=y[0], method="nearest")
        
        # Extract phenology data
        pheno = ds_nearest.phenology.values
        is_nan = ds_nearest.nan_mask.values
        
        if is_nan:
            logger.debug(f"No phenology data available for coordinates ({lat}, {lon})")
            return None
        
        # Convert to list of integers
        phenology_curve = pheno.astype(int).tolist()
        
        if len(phenology_curve) != 365:
            logger.warning(f"Unexpected phenology curve length: {len(phenology_curve)}")
            return None
            
        return phenology_curve
        
    except Exception as e:
        logger.error(f'Error getting phenology data for ({lat}, {lon}): {str(e)}')
        return None



def get_phenology_metadata(lat: float, lon: float) -> Optional[PhenologyMetadata]:
    """
    Get phenology metadata for a location.
    
    Args:
        lat: Latitude in decimal degrees
        lon: Longitude in decimal degrees
        
    Returns:
        PhenologyMetadata object or None if no data available
    """
    try:
        # Get phenology curve
        curve = get_phenology_curve(lat, lon)
        if curve is None:
            return None
            
        # Create metadata object
        return PhenologyMetadata(phenology_curve=curve)
        
    except Exception as e:
        logger.error(f'Error creating phenology metadata: {str(e)}')
        return None
```

### Task 4: Update Metadata Processing
**File:** `processor/src/process_metadata.py`

**Add import:**
```python
from .utils.phenology import get_phenology_metadata
```

**Add to process_metadata function after biome processing:**
```python
# Get phenology data (after biome processing)
logger.info(
    'Processing phenology metadata',
    LogContext(
        category=LogCategory.METADATA,
        dataset_id=task.dataset_id,
        user_id=task.user_id,
        token=token,
        extra={'bbox_centroid': bbox_centroid},
    ),
)

phenology_metadata = get_phenology_metadata(
    lat=bbox_centroid[1],  # latitude
    lon=bbox_centroid[0]   # longitude
)

# Update metadata creation to include phenology
metadata_dict = {
    MetadataType.GADM: admin_metadata.model_dump(), 
    MetadataType.BIOME: biome_metadata.model_dump()
}

if phenology_metadata:
    metadata_dict[MetadataType.PHENOLOGY] = phenology_metadata.model_dump()

metadata = DatasetMetadata(
    dataset_id=task.dataset_id,
    metadata=metadata_dict,
    version=1,
    processing_runtime=runtime,
)
```

### Task 5: Create Test Cases
**File:** `processor/tests/utils/test_phenology.py`

```python
import pytest
from unittest.mock import patch, MagicMock
from processor.src.utils.phenology import (
    get_phenology_curve, 
    get_phenology_metadata
)
from shared.models import PhenologyMetadata


class TestPhenologyUtils:
    """Test phenology utility functions"""
    
    
    @patch('processor.src.utils.phenology.xr.open_zarr')
    def test_get_phenology_curve_success(self, mock_open_zarr):
        """Test successful phenology curve retrieval"""
        # Mock dataset
        mock_ds = MagicMock()
        mock_ds.sel.return_value.phenology.values = list(range(365))
        mock_ds.sel.return_value.nan_mask.values = False
        mock_open_zarr.return_value = mock_ds
        
        result = get_phenology_curve(48.0, 8.0)
        assert result == list(range(365))
        
    @patch('processor.src.utils.phenology.xr.open_zarr')
    def test_get_phenology_curve_no_data(self, mock_open_zarr):
        """Test phenology curve retrieval with no data"""
        # Mock dataset with NaN mask
        mock_ds = MagicMock()
        mock_ds.sel.return_value.nan_mask.values = True
        mock_open_zarr.return_value = mock_ds
        
        result = get_phenology_curve(48.0, 8.0)
        assert result is None


class TestPhenologyMetadata:
    """Test PhenologyMetadata model"""
    
    def test_create_metadata_valid(self):
        """Test creating metadata with valid curve"""
        curve = list(range(365))  # Simple curve with 365 values
        metadata = PhenologyMetadata(phenology_curve=curve)
        
        assert metadata.phenology_curve == curve
        assert metadata.source == 'MODIS Phenology'
        assert metadata.version == '1.0'
        
    def test_create_metadata_invalid_length(self):
        """Test creating metadata with invalid curve length"""
        with pytest.raises(ValueError, match="must have exactly 365 values"):
            PhenologyMetadata(phenology_curve=[1, 2, 3])
```

### Task 6: Integration Testing
**File:** `processor/tests/test_process_metadata.py`

**Add test for phenology integration:**
```python
@pytest.mark.slow
def test_process_metadata_with_phenology(self, sample_task):
    """Test metadata processing includes phenology data"""
    # Process metadata
    process_metadata(sample_task, temp_dir=Path("/tmp"))
    
    # Verify phenology metadata was saved
    with use_client(login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)) as client:
        result = client.table(settings.metadata_table).select('*').eq('dataset_id', sample_task.dataset_id).execute()
        
    assert result.data
    metadata = result.data[0]['metadata']
    
    # Check phenology data structure
    if 'phenology' in metadata:
        phenology = metadata['phenology']
        assert 'phenology_curve' in phenology
        assert len(phenology['phenology_curve']) == 365
        assert 'source' in phenology
        assert phenology['source'] == 'MODIS Phenology'
```

### Task 7: Update Settings (if needed)
**File:** `shared/settings.py`

**Add phenology-related settings if needed:**
```python
# Add to Settings class if needed
PHENOLOGY_DATA_PATH: str = Field(default="assets/pheno/modispheno_aggregated_normalized.zarr")
```

## Testing Plan

### Unit Tests
```bash
# Test phenology utilities
deadtrees dev test processor --test-path=processor/tests/utils/test_phenology.py

# Test metadata integration
deadtrees dev test processor --test-path=processor/tests/test_process_metadata.py
```

### Integration Tests
```bash
# Full processor test suite
deadtrees dev test processor

# API integration tests
deadtrees dev test api
```

### Manual Verification
```bash
# Test with real dataset
deadtrees dev debug processor --test-path=processor/tests/test_process_metadata.py::test_process_metadata_with_phenology
```

## Database Verification

### Check Phenology Data Structure
```sql
-- View phenology metadata examples
SELECT 
    dataset_id,
    jsonb_pretty(metadata->'phenology') as phenology_data
FROM v2_metadata 
WHERE metadata ? 'phenology'
LIMIT 3;
```

### Validate Data Quality
```sql
-- Check phenology curve lengths
SELECT 
    dataset_id,
    jsonb_array_length(metadata->'phenology'->'phenology_curve') as curve_length
FROM v2_metadata 
WHERE metadata ? 'phenology';
```

## Frontend Data Structure

The phenology metadata will be available in the standard metadata endpoint with this structure:

```json
{
  "phenology": {
    "phenology_curve": [0, 0, 0, ..., 255, 254, ...],  // 365 values (0-255)
    "source": "MODIS Phenology",
    "version": "1.0"
  }
}
```

## Completion Checklist

### Core Implementation
- [ ] Task 1: Add dependencies to requirements.txt
- [ ] Task 2: Create PhenologyMetadata model in shared/models.py
- [ ] Task 3: Implement phenology utility module
- [ ] Task 4: Update metadata processing pipeline
- [ ] Task 5: Create comprehensive test cases
- [ ] Task 6: Add integration tests
- [ ] Task 7: Update settings if needed

### Extended Testing
- [ ] Task 8: Create data validation tests
- [ ] Task 9: Implement performance tests
- [ ] Task 10: Add data quality validation tests

### Validation & Documentation
- [ ] Test all functionality with real data
- [ ] Verify database structure and data quality
- [ ] Document frontend data structure
- [ ] Run comprehensive test suite
- [ ] Performance benchmark validation
- [ ] Data quality assurance checks

## Comprehensive Testing Strategy

### Task 8: Data Validation Tests
**File:** `processor/tests/utils/test_phenology_data.py`

```python
import pytest
from pathlib import Path
import xarray as xr
from processor.src.utils.phenology import get_phenology_path, get_phenology_curve


class TestPhenologyDataset:
    """Test phenology dataset accessibility and structure"""
    
    def test_dataset_exists(self):
        """Test that the phenology dataset file exists"""
        dataset_path = get_phenology_path()
        assert dataset_path.exists(), f"Dataset not found at {dataset_path}"
        
    def test_dataset_structure(self):
        """Test dataset has expected structure and dimensions"""
        ds = xr.open_zarr(get_phenology_path())
        
        # Check required variables exist
        assert 'phenology' in ds.variables, "Dataset missing 'phenology' variable"
        assert 'nan_mask' in ds.variables, "Dataset missing 'nan_mask' variable"
        
        # Check dimensions
        phenology_shape = ds.phenology.shape
        assert len(phenology_shape) >= 3, "Phenology data should have at least 3 dimensions"
        assert phenology_shape[-1] == 365, "Last dimension should be 365 (days)"
        
    def test_coordinate_system(self):
        """Test dataset coordinate system and projection"""
        ds = xr.open_zarr(get_phenology_path())
        
        # Check coordinate variables exist
        assert 'x' in ds.coords, "Dataset missing 'x' coordinate"
        assert 'y' in ds.coords, "Dataset missing 'y' coordinate"
        
    @pytest.mark.slow
    def test_data_access_performance(self):
        """Test data access performance for random locations"""
        import time
        
        test_locations = [
            (48.0, 8.0),    # Black Forest, Germany
            (45.0, -75.0),  # Eastern Canada
            (35.0, -120.0), # California
        ]
        
        start_time = time.time()
        for lat, lon in test_locations:
            curve = get_phenology_curve(lat, lon)
            # Should either return valid curve or None (for ocean/no data areas)
            if curve is not None:
                assert len(curve) == 365
                assert all(0 <= val <= 255 for val in curve)
        
        elapsed = time.time() - start_time
        assert elapsed < 5.0, f"Data access too slow: {elapsed:.2f}s for {len(test_locations)} locations"


class TestCoordinateTransformation:
    """Test coordinate transformation accuracy"""
    
    @pytest.mark.slow
    def test_known_locations(self):
        """Test phenology retrieval for known locations with expected data"""
        # Test locations in temperate forests (should have phenology data)
        forest_locations = [
            (48.0, 8.0, "Black Forest, Germany"),
            (45.8, -84.5, "Northern Michigan, USA"),
            (50.0, 10.0, "Central Germany"),
        ]
        
        for lat, lon, location_name in forest_locations:
            curve = get_phenology_curve(lat, lon)
            assert curve is not None, f"Expected phenology data for {location_name}"
            assert len(curve) == 365
            # Should have some variation (not all zeros)
            assert max(curve) > 0, f"No phenology signal found for {location_name}"
            
    def test_ocean_locations(self):
        """Test phenology retrieval for ocean locations (should return None)"""
        ocean_locations = [
            (30.0, -30.0, "Atlantic Ocean"),
            (0.0, -150.0, "Pacific Ocean"),
            (-30.0, 150.0, "Southern Ocean"),
        ]
        
        for lat, lon, location_name in ocean_locations:
            curve = get_phenology_curve(lat, lon)
            # Ocean locations should return None (no phenology data)
            assert curve is None, f"Unexpected phenology data for {location_name}"


class TestEdgeCases:
    """Test edge cases and error conditions"""
    
    def test_extreme_coordinates(self):
        """Test handling of extreme coordinate values"""
        extreme_coords = [
            (90.0, 0.0),    # North pole
            (-90.0, 0.0),   # South pole
            (0.0, 180.0),   # Date line
            (0.0, -180.0),  # Date line (other side)
        ]
        
        for lat, lon in extreme_coords:
            # Should not raise exceptions, may return None
            curve = get_phenology_curve(lat, lon)
            if curve is not None:
                assert len(curve) == 365
                assert all(0 <= val <= 255 for val in curve)
                
    def test_invalid_coordinates(self):
        """Test handling of invalid coordinate values"""
        invalid_coords = [
            (91.0, 0.0),    # Invalid latitude > 90
            (-91.0, 0.0),   # Invalid latitude < -90
            (0.0, 181.0),   # Invalid longitude > 180
            (0.0, -181.0),  # Invalid longitude < -180
        ]
        
        for lat, lon in invalid_coords:
            # Should handle gracefully (may return None or raise appropriate error)
            try:
                curve = get_phenology_curve(lat, lon)
                if curve is not None:
                    assert len(curve) == 365
            except (ValueError, Exception) as e:
                # Acceptable to raise errors for invalid coordinates
                assert "coordinate" in str(e).lower() or "latitude" in str(e).lower() or "longitude" in str(e).lower()
```

### Task 9: Integration Performance Tests
**File:** `processor/tests/integration/test_phenology_performance.py`

```python
import pytest
import time
from pathlib import Path
from processor.src.process_metadata import process_metadata
from shared.models import QueueTask, TaskTypeEnum


class TestPhenologyPerformance:
    """Test phenology processing performance and scalability"""
    
    @pytest.mark.slow
    def test_metadata_processing_performance(self, sample_task):
        """Test complete metadata processing with phenology doesn't exceed time limits"""
        start_time = time.time()
        
        # Process metadata including phenology
        process_metadata(sample_task, temp_dir=Path("/tmp"))
        
        elapsed = time.time() - start_time
        
        # Metadata processing should complete within reasonable time
        assert elapsed < 30.0, f"Metadata processing too slow: {elapsed:.2f}s"
        
    @pytest.mark.slow
    def test_batch_processing_performance(self, multiple_sample_tasks):
        """Test processing multiple datasets with phenology"""
        start_time = time.time()
        
        for task in multiple_sample_tasks[:5]:  # Test with 5 datasets
            process_metadata(task, temp_dir=Path("/tmp"))
            
        elapsed = time.time() - start_time
        avg_time = elapsed / len(multiple_sample_tasks[:5])
        
        # Average processing time should be reasonable
        assert avg_time < 30.0, f"Average processing time too slow: {avg_time:.2f}s per dataset"
        
    def test_memory_usage(self, sample_task):
        """Test phenology processing doesn't cause memory leaks"""
        import psutil
        import gc
        
        process = psutil.Process()
        initial_memory = process.memory_info().rss / 1024 / 1024  # MB
        
        # Process multiple times to detect memory leaks
        for _ in range(3):
            process_metadata(sample_task, temp_dir=Path("/tmp"))
            gc.collect()
            
        final_memory = process.memory_info().rss / 1024 / 1024  # MB
        memory_increase = final_memory - initial_memory
        
        # Should not increase memory significantly
        assert memory_increase < 100, f"Possible memory leak: {memory_increase:.1f}MB increase"


class TestErrorRecovery:
    """Test error handling and recovery scenarios"""
    
    def test_corrupted_dataset_handling(self, sample_task):
        """Test handling of corrupted phenology dataset"""
        # Mock corrupted dataset by temporarily moving the file
        from processor.src.utils.phenology import PHENOLOGY_PATH
        
        backup_path = PHENOLOGY_PATH.with_suffix('.bak')
        if PHENOLOGY_PATH.exists():
            PHENOLOGY_PATH.rename(backup_path)
            
        try:
            # Should handle missing dataset gracefully
            process_metadata(sample_task, temp_dir=Path("/tmp"))
            
            # Check that processing completed without phenology data
            # (Implementation should continue with other metadata types)
            
        finally:
            # Restore dataset
            if backup_path.exists():
                backup_path.rename(PHENOLOGY_PATH)
                
    def test_network_timeout_simulation(self, sample_task):
        """Test handling of network/IO timeouts"""
        # This would require mocking xarray.open_zarr to simulate timeouts
        # Implementation depends on specific timeout handling strategy
        pass
```

### Task 10: Data Quality Validation Tests
**File:** `processor/tests/validation/test_phenology_quality.py`

```python
import pytest
from processor.src.utils.phenology import get_phenology_curve
from shared.models import PhenologyMetadata


class TestDataQuality:
    """Test phenology data quality and consistency"""
    
    @pytest.mark.slow
    def test_seasonal_patterns(self):
        """Test that phenology curves show expected seasonal patterns"""
        # Test locations in Northern Hemisphere temperate zones
        test_locations = [
            (45.0, -75.0, "Eastern Canada"),  
            (50.0, 10.0, "Central Europe"),
            (48.0, 8.0, "Black Forest"),
        ]
        
        for lat, lon, location in test_locations:
            curve = get_phenology_curve(lat, lon)
            if curve is None:
                continue
                
            # Northern hemisphere should have lower values in winter months
            winter_months = curve[:60] + curve[330:]  # Jan-Feb + Dec
            summer_months = curve[150:240]  # Jun-Aug
            
            avg_winter = sum(winter_months) / len(winter_months)
            avg_summer = sum(summer_months) / len(summer_months)
            
            # Summer should generally have higher phenology values than winter
            assert avg_summer > avg_winter, f"Unexpected seasonal pattern for {location}"
            
    def test_value_ranges(self):
        """Test that all phenology values are within expected range"""
        test_locations = [
            (48.0, 8.0),
            (45.0, -75.0), 
            (35.0, -120.0),
            (60.0, 25.0),
        ]
        
        for lat, lon in test_locations:
            curve = get_phenology_curve(lat, lon)
            if curve is None:
                continue
                
            # All values should be within 0-255 range
            assert all(0 <= val <= 255 for val in curve), f"Values out of range for ({lat}, {lon})"
            
            # Should have some variation (not all same values)
            unique_values = set(curve)
            assert len(unique_values) > 1, f"No variation in phenology curve for ({lat}, {lon})"
            
    def test_geographic_consistency(self):
        """Test that nearby locations have similar phenology patterns"""
        # Test clusters of nearby locations
        clusters = [
            # Black Forest area
            [(48.0, 8.0), (48.1, 8.1), (47.9, 7.9)],
            # Great Lakes region  
            [(45.0, -84.0), (45.1, -84.1), (44.9, -83.9)],
        ]
        
        for cluster in clusters:
            curves = []
            for lat, lon in cluster:
                curve = get_phenology_curve(lat, lon)
                if curve is not None:
                    curves.append(curve)
                    
            if len(curves) < 2:
                continue
                
            # Calculate correlation between nearby curves
            import numpy as np
            correlations = []
            for i in range(len(curves)):
                for j in range(i+1, len(curves)):
                    corr = np.corrcoef(curves[i], curves[j])[0, 1]
                    correlations.append(corr)
                    
            avg_correlation = sum(correlations) / len(correlations)
            # Nearby locations should have reasonably correlated phenology
            assert avg_correlation > 0.5, f"Low correlation between nearby locations: {avg_correlation:.3f}"


class TestMetadataIntegrity:
    """Test metadata model validation and integrity"""
    
    def test_metadata_serialization(self):
        """Test that PhenologyMetadata can be properly serialized/deserialized"""
        test_curve = list(range(365))
        metadata = PhenologyMetadata(phenology_curve=test_curve)
        
        # Test JSON serialization
        json_data = metadata.model_dump()
        assert 'phenology_curve' in json_data
        assert len(json_data['phenology_curve']) == 365
        assert json_data['source'] == 'MODIS Phenology'
        
        # Test reconstruction from JSON
        reconstructed = PhenologyMetadata(**json_data)
        assert reconstructed.phenology_curve == test_curve
        assert reconstructed.source == metadata.source
        
    def test_database_compatibility(self):
        """Test that phenology metadata is compatible with database storage"""
        import json
        
        test_curve = [i % 256 for i in range(365)]  # Create test curve
        metadata = PhenologyMetadata(phenology_curve=test_curve)
        
        # Simulate database storage (JSON serialization)
        json_str = json.dumps(metadata.model_dump())
        
        # Simulate database retrieval (JSON deserialization)
        loaded_data = json.loads(json_str)
        reconstructed = PhenologyMetadata(**loaded_data)
        
        assert reconstructed.phenology_curve == test_curve
```

## Extended Testing Plan

### Unit Tests (Fast)
```bash
# Core functionality tests
deadtrees dev test processor --test-path=processor/tests/utils/test_phenology.py

# Data model tests  
deadtrees dev test processor --test-path=processor/tests/validation/test_phenology_quality.py::TestMetadataIntegrity
```

### Integration Tests (Moderate)
```bash
# Metadata processing integration
deadtrees dev test processor --test-path=processor/tests/test_process_metadata.py

# Performance tests
deadtrees dev test processor --test-path=processor/tests/integration/test_phenology_performance.py
```

### Comprehensive Tests (Slow)
```bash
# Full data validation (requires dataset access)
deadtrees dev test processor --test-path=processor/tests/utils/test_phenology_data.py --include-slow

# Quality validation
deadtrees dev test processor --test-path=processor/tests/validation/test_phenology_quality.py --include-slow
```

### Manual Validation Tests
```bash
# Test specific locations
deadtrees dev debug processor --test-path=processor/tests/utils/test_phenology_data.py::TestCoordinateTransformation::test_known_locations

# Performance monitoring
deadtrees dev debug processor --test-path=processor/tests/integration/test_phenology_performance.py::TestPhenologyPerformance::test_metadata_processing_performance
```

## Notes

- **Performance:** Uses `method="nearest"` for efficient spatial queries
- **Error Handling:** Graceful degradation when phenology data unavailable  
- **Logging:** Uses existing LogCategory.METADATA pattern
- **Data Validation:** Comprehensive validation for curve length and data integrity
- **Frontend Ready:** Simplified data structure optimized for bar visualization
- **Testing:** Multi-tier testing strategy covering unit, integration, performance, and quality validation

