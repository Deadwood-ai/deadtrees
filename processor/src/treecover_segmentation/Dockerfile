FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime
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

# Copy the TCD source code
COPY --chown=deadtrees:deadtrees tcd_repo/ ./tcd/

WORKDIR /home/deadtrees/tcd
ENV PATH=/home/deadtrees/.local/bin:$PATH

# Switch to root to install packages system-wide (for root access like ODM)
USER root
RUN python -m pip install --no-cache-dir -r requirements.txt
RUN python -m pip install --no-cache-dir -e .

# Create the entrypoint script
COPY --chown=deadtrees:deadtrees entrypoint.sh /home/deadtrees/entrypoint.sh
RUN chmod +x /home/deadtrees/entrypoint.sh

USER deadtrees
WORKDIR /home/deadtrees

ENTRYPOINT ["/home/deadtrees/entrypoint.sh"]
CMD ["--help"]