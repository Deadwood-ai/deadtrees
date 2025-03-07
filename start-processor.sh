#!/bin/bash

# Navigate to the project directory
cd /home/jj1049/prod/deadtrees

# Set up logging
LOG_FILE="/home/jj1049/prod/deadtrees/processor_startup.log"
echo "===============================================" >> $LOG_FILE
echo "Starting processor container at $(date)" >> $LOG_FILE

# Export environment variables from .env file if needed
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
  echo "Loaded environment variables from .env file" >> $LOG_FILE
fi

# Check if the container is already running
if docker-compose -f docker-compose.processor.yaml ps | grep -q "processor"; then
  echo "Processor container is already running. Skipping startup." >> $LOG_FILE
else
  # Start the container
  echo "Starting processor container..." >> $LOG_FILE
  docker-compose -f docker-compose.processor.yaml up -d
  
  # Check if the container started successfully
  if [ $? -eq 0 ]; then
    echo "Processor container started successfully." >> $LOG_FILE
  else
    echo "Failed to start processor container. See Docker logs for details." >> $LOG_FILE
  fi
fi

echo "Script completed at $(date)" >> $LOG_FILE
echo "===============================================" >> $LOG_FILE 