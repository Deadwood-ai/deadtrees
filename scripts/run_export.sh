#!/bin/bash
#
# Helper script to run reference export with proper environment setup
# 
# Usage:
#   ./scripts/run_export.sh                    # Normal run (incremental)
#   ./scripts/run_export.sh --force            # Force re-export all
#   ./scripts/run_export.sh --dataset-id 420   # Export specific dataset
#   ./scripts/run_export.sh --resolution 20    # Export specific resolution

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_ROOT}/.env.export"
VENV_PATH="${PROJECT_ROOT}/venv"
EXPORT_SCRIPT="${PROJECT_ROOT}/scripts/export_reference_patches.py"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env.export exists
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}ERROR: $ENV_FILE not found!${NC}"
    echo "Create it with: cp ${PROJECT_ROOT}/.env.export.template ${ENV_FILE}"
    exit 1
fi

# Check if venv exists
if [ ! -d "$VENV_PATH" ]; then
    echo -e "${RED}ERROR: Python virtual environment not found at $VENV_PATH${NC}"
    echo "Create it with:"
    echo "  python3 -m venv venv"
    echo "  source venv/bin/activate"
    echo "  pip install -r api/requirements.txt"
    exit 1
fi

# Load environment variables
set -a
source "$ENV_FILE"
set +a

# Verify UUID is set
if [ -z "${REFERENCE_EXPORT_UUID:-}" ]; then
    echo -e "${RED}ERROR: REFERENCE_EXPORT_UUID not set in $ENV_FILE${NC}"
    exit 1
fi

# Activate virtual environment
echo -e "${GREEN}✓ Activating virtual environment...${NC}"
source "${VENV_PATH}/bin/activate"

# Set Python path
export PYTHONPATH="${PROJECT_ROOT}"

# Run export script with any provided arguments
echo -e "${GREEN}✓ Running export script...${NC}"
echo -e "${YELLOW}UUID: $REFERENCE_EXPORT_UUID${NC}"
echo ""

python "$EXPORT_SCRIPT" "$@"

EXIT_CODE=$?

# Deactivate virtual environment
deactivate

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Export completed successfully${NC}"
else
    echo ""
    echo -e "${RED}✗ Export failed with exit code $EXIT_CODE${NC}"
fi

exit $EXIT_CODE

