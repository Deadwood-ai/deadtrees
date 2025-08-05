# Use the same base image as the original TCD Dockerfile
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

# Set non-interactive frontend for package installations
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Zurich

# Update package lists and install essential dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    wget \
    bzip2 \
    libglib2.0-0 \
    libxext6 \
    libsm6 \
    libxrender1 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user for better security
RUN useradd -m -s /bin/bash appuser
USER appuser
WORKDIR /home/appuser

# Clone the TCD repository
RUN git clone https://github.com/Restor-Foundation/tcd.git tcd_repo

# Install Python dependencies from the repository
WORKDIR /home/appuser/tcd_repo
RUN pip install --no-cache-dir -r requirements.txt

# Install the TCD package itself in editable mode
RUN pip install --no-cache-dir -e .

# Set the entrypoint to the TCD prediction script
ENTRYPOINT ["tcd-predict"]
