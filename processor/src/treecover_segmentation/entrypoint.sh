#!/bin/bash

# Entry point script for TCD container
# This script handles the command line interface to run TCD predictions

cd /home/deadtrees/tcd

# Check if the first argument is a known TCD command
case "$1" in
    "tcd-predict")
        # Handle tcd-predict semantic commands specifically
        # Expected format: tcd-predict semantic input_path output_path [--model=model_name]
        if [ "$2" = "semantic" ]; then
            if [ $# -lt 4 ]; then
                echo "Usage: tcd-predict semantic <input_path> <output_path> [--model=model_name]"
                exit 1
            fi
            
            INPUT_PATH="$3"
            OUTPUT_PATH="$4"
            MODEL="semantic"  # Use semantic as the model identifier
            
            # Parse additional arguments for model specification
            shift 4
            while [[ $# -gt 0 ]]; do
                case $1 in
                    --model=*)
                        # Extract model name but keep semantic as the model_or_config
                        MODEL_NAME="${1#*=}"
                        shift
                        ;;
                    *)
                        echo "Unknown option $1"
                        shift
                        ;;
                esac
            done
            
            echo "Running TCD semantic segmentation..."
            echo "Input: $INPUT_PATH"
            echo "Output: $OUTPUT_PATH"
            echo "Model config: $MODEL"
            
            # Create output directory
            mkdir -p "$OUTPUT_PATH"
            
            # Run TCD prediction with semantic model
            exec python predict.py "$MODEL" "$INPUT_PATH" "$OUTPUT_PATH"
        else
            # Run the direct predict.py script with the remaining arguments for other commands
            exec python predict.py "${@:2}"
        fi
        ;;
    "semantic")
        # Handle the semantic segmentation case used by our hybrid approach
        # Expected format: semantic input_path output_path --model=model_name
        if [ $# -lt 3 ]; then
            echo "Usage: semantic <input_path> <output_path> [--model=model_name]"
            exit 1
        fi
        
        INPUT_PATH="$2"
        OUTPUT_PATH="$3"
        MODEL="restor/tcd-segformer-mit-b5"  # Default model
        
        # Parse additional arguments
        shift 3
        while [[ $# -gt 0 ]]; do
            case $1 in
                --model=*)
                    MODEL="${1#*=}"
                    shift
                    ;;
                *)
                    echo "Unknown option $1"
                    shift
                    ;;
            esac
        done
        
        echo "Running TCD semantic segmentation..."
        echo "Input: $INPUT_PATH"
        echo "Output: $OUTPUT_PATH"
        echo "Model: $MODEL"
        
        # Create output directory
        mkdir -p "$OUTPUT_PATH"
        
        # Run TCD prediction with semantic model directly
        exec python predict.py semantic "$INPUT_PATH" "$OUTPUT_PATH"
        ;;
    "--help"|"help")
        echo "DeadTrees TCD Container"
        echo ""
        echo "Usage:"
        echo "  tcd-predict <model> <input> <output> [options]  - Run TCD prediction"
        echo "  semantic <input> <output> [--model=model]       - Run semantic segmentation"
        echo "  --help                                           - Show this help"
        echo ""
        echo "Examples:"
        echo "  semantic /input/ortho.tif /output --model=restor/tcd-segformer-mit-b5"
        echo "  tcd-predict semantic /input/ortho.tif /output"
        ;;
    *)
        # If no recognized command, try to run it directly as a TCD command
        exec python predict.py "$@"
        ;;
esac