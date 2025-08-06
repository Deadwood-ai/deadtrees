# Start with GDAL image
FROM ghcr.io/osgeo/gdal:ubuntu-full-latest

# Install Python and development tools
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-dev \
    python3-venv \
    build-essential \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set environment variables for GDAL
RUN echo "GDAL_VERSION=$(gdal-config --version)" >> /etc/environment
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

# Set up the application maintaining local structure
WORKDIR /app
RUN mkdir -p /app/processor/src/deadwood_segmentation/deadtreesmodels/data
RUN mkdir -p /data

# Copy deadtreesmodels requirements and install
COPY processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt /app/processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt
RUN pip3 install --no-cache-dir -r /app/processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt

# Copy and install main requirements
COPY processor/requirements.txt /app/processor/requirements.txt
RUN pip3 install --no-cache-dir -r /app/processor/requirements.txt

# Copy application files
COPY ./processor /app/processor
COPY ./shared /app/shared

# Copy pytest configuration for custom marks
COPY pytest.ini /app/pytest.ini

# Copy entrypoint script and make it executable
COPY processor/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set working directory for execution
WORKDIR /app

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Default command
CMD ["python", "-m", "processor.src.processor"]

# Note: Model file should be mounted at runtime
