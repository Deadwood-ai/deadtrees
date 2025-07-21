#!/bin/bash

# Create ODM Test Data ZIP Files
# This script creates test ZIP files from the available DJI drone images
# for ODM testing at different scales

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Directories
SOURCE_DIR="assets/test_data/raw_drone_images/DJI_202504031231_008_hartheimwithbuffer60m"
TARGET_DIR="assets/test_data/raw_drone_images"

echo -e "${YELLOW}Creating ODM test data ZIP files...${NC}"

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}Error: Source directory not found: $SOURCE_DIR${NC}"
    echo "Please ensure the DJI drone images are available."
    exit 1
fi

# Create target directory if it doesn't exist
mkdir -p "$TARGET_DIR"

cd "$SOURCE_DIR"

# Check if we have enough images
JPG_COUNT=$(find . -name "DJI_*_D.JPG" | wc -l)
echo "Found $JPG_COUNT DJI drone images"

if [ "$JPG_COUNT" -lt 3 ]; then
    echo -e "${RED}Error: Need at least 3 images for testing, found $JPG_COUNT${NC}"
    exit 1
fi

# Function to create ZIP file with progress
create_zip() {
    local zip_name=$1
    local pattern=$2
    local description=$3
    
    echo -e "${YELLOW}Creating $zip_name - $description...${NC}"
    
    # Count files that match the pattern
    local file_count=$(find . -name "$pattern" | wc -l)
    
    if [ "$file_count" -eq 0 ]; then
        echo -e "${RED}Warning: No files match pattern $pattern${NC}"
        return 1
    fi
    
    # Create ZIP file
    find . -name "$pattern" | head -n $4 | zip "../$zip_name" -@
    
    # Check if ZIP was created successfully
    if [ -f "../$zip_name" ]; then
        local zip_size=$(du -h "../$zip_name" | cut -f1)
        echo -e "${GREEN}✓ Created $zip_name ($file_count files, $zip_size)${NC}"
    else
        echo -e "${RED}✗ Failed to create $zip_name${NC}"
        return 1
    fi
}

# Create test ZIP files
echo ""

# 1. Minimal set (3 images) - fastest testing
create_zip "test_minimal_3_images.zip" "DJI_*_D.JPG" "Minimal valid ODM set" 3

# 2. Small set (10 images) - development testing  
create_zip "test_small_10_images.zip" "DJI_*_D.JPG" "Small development set" 10

# 3. Medium set (25 images) - comprehensive testing
create_zip "test_medium_25_images.zip" "DJI_*_D.JPG" "Medium comprehensive set" 25

# 4. Invalid set (2 images) - error testing
create_zip "test_invalid_2_images.zip" "DJI_*_D.JPG" "Invalid set for error testing" 2

echo ""
echo -e "${GREEN}✓ All ODM test ZIP files created successfully!${NC}"
echo ""
echo "Test files created in $TARGET_DIR:"
ls -lh "$TARGET_DIR"/test_*.zip 2>/dev/null || echo "No ZIP files found"
echo ""
echo -e "${YELLOW}Usage in tests:${NC}"
echo "- test_minimal_3_images.zip: Fast unit tests, basic ODM functionality"
echo "- test_small_10_images.zip: Development testing, pipeline validation"  
echo "- test_medium_25_images.zip: Comprehensive testing, performance validation"
echo "- test_invalid_2_images.zip: Error handling tests (insufficient images)"
echo ""
echo -e "${GREEN}Ready for ODM testing!${NC}" 