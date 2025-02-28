# Start with GDAL image
FROM ghcr.io/osgeo/gdal:ubuntu-full-latest

# Install Python and development tools
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-dev \
    build-essential \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Miniconda
RUN wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O /tmp/miniconda.sh && \
    bash /tmp/miniconda.sh -b -p /opt/conda && \
    rm /tmp/miniconda.sh
ENV PATH="/opt/conda/bin:$PATH"

# Set environment variables for GDAL
RUN echo "GDAL_VERSION=$(gdal-config --version)" >> /etc/environment
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

# Set up the application maintaining local structure
WORKDIR /app
RUN mkdir -p /app/processor/src/deadwood_segmentation/deadtreesmodels/data
RUN mkdir -p /app/processor/src/treecover/tcd
RUN mkdir -p /data

# Clone the TCD repository directly into the treecover directory
RUN git clone https://github.com/restor-foundation/tcd.git /app/processor/src/treecover/tcd

# Create a single conda environment for all dependencies
SHELL ["/bin/bash", "-c"]

# Create conda environment using the TCD environment.yml file as a base
RUN cd /app/processor/src/treecover/tcd && \
    conda env create -n deadtrees -f environment.yml && \
    conda init bash && \
    echo "conda activate deadtrees" >> ~/.bashrc

# Make conda environment available in PATH
ENV PATH="/opt/conda/envs/deadtrees/bin:$PATH"
ENV CONDA_DEFAULT_ENV="deadtrees"
ENV CONDA_PREFIX="/opt/conda/envs/deadtrees"

# Copy deadtreesmodels requirements and install in the same conda environment
COPY processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt /app/processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt
RUN pip install --no-cache-dir -r /app/processor/src/deadwood_segmentation/deadtreesmodels/requirements.txt

# Install TCD in development mode
RUN cd /app/processor/src/treecover/tcd && \
    pip install -e . && \
    pip install jsonlines

# Copy and install main requirements in the same conda environment
COPY processor/requirements.txt /app/processor/requirements.txt
RUN pip install --no-cache-dir -r /app/processor/requirements.txt

# Fix wandb/protobuf compatibility issue
RUN pip install protobuf==3.20.1

# Copy application files
COPY ./processor /app/processor
COPY ./shared /app/shared

# Set working directory for execution
WORKDIR /app

# Default command to keep container running
CMD ["tail", "-f", "/dev/null"]

# Note: Model file should be mounted at runtime
