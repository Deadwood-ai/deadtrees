# Start with a pinned GDAL image so Python/GDAL don't drift underneath the processor.
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.10.3@sha256:b50822a4059629f6a579908584e25e6adccfc70a57914290dd01217f19871d08

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
ENV PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu121

# Set environment variables for GDAL
RUN echo "GDAL_VERSION=$(gdal-config --version)" >> /etc/environment
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

# Set up the application maintaining local structure
WORKDIR /app
RUN mkdir -p /app/processor/src/deadwood_segmentation/deadtreesmodels/data
RUN mkdir -p /data

# PyTorch 2.4 adds Python 3.12 support for torch.compile while still offering CUDA 12.1 wheels.
RUN pip3 install --no-cache-dir torch==2.4.1 torchvision==0.19.1

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
