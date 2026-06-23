FROM pytorch/pytorch:2.7.1-cuda11.8-cudnn9-runtime
ENV TZ=Europe/Zurich

# set bash as current shell
RUN chsh -s /bin/bash
SHELL ["/bin/bash", "-c"]

# Apt update and clean
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    wget \
    bzip2 \
    build-essential \
    ca-certificates \
    libglib2.0-0 \
    libxext6 \
    libsm6 \
    libxrender1 \
    git \
    mercurial \
    subversion \
    gdal-bin \
    libgdal-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for GDAL
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal
ENV C_INCLUDE_PATH=/usr/include/gdal

# Setup deadtrees user (instead of restor)
RUN groupadd -r deadtrees && useradd -r -g deadtrees deadtrees
RUN mkdir /home/deadtrees
RUN chown -R deadtrees:deadtrees /home/deadtrees
RUN chmod 755 /home/deadtrees

USER deadtrees
WORKDIR /home/deadtrees

# Clone the TCD repository (as deadtrees user)
RUN git clone https://github.com/cmosig/tcd.git ./tcd

WORKDIR /home/deadtrees/tcd
ENV PATH=/home/deadtrees/.local/bin:$PATH

# Switch to root to install packages system-wide (for root access like ODM)
USER root

# The base image ships torch 2.7.1 built for CUDA 11.8 (cu118). tcd requires
# torch>=2.7.0, so the base already satisfies it and pip won't upgrade torch —
# avoiding the latest cu130 wheel, which is too new for the GPU host drivers
# (prod CUDA 12.2, dev 12.8) and would make torch silently fall back to CPU. cu118
# runs on any driver >= 11.8, covering the whole GPU fleet. The constraint locks
# torch's CUDA build so an unpinned transitive dep (e.g. torchvision) can't quietly
# pull a cu126/cu128/cu130 wheel the prod driver can't run.
RUN printf 'torch==2.7.1\n' > /tmp/torch-constraints.txt
RUN PIP_CONSTRAINT=/tmp/torch-constraints.txt python -m pip install --no-cache-dir -r requirements.txt
RUN PIP_CONSTRAINT=/tmp/torch-constraints.txt python -m pip install --no-cache-dir -e .

# Create the entrypoint script
COPY --chown=deadtrees:deadtrees entrypoint.sh /home/deadtrees/entrypoint.sh
RUN chmod +x /home/deadtrees/entrypoint.sh

USER deadtrees
WORKDIR /home/deadtrees

ENTRYPOINT ["/home/deadtrees/entrypoint.sh"]
CMD ["--help"]