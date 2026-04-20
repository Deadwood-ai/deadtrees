# Start from the same GDAL image we use for processor so arm64 geospatial builds
# can reuse distro-provided Python bindings instead of compiling from source.
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.10.3@sha256:b50822a4059629f6a579908584e25e6adccfc70a57914290dd01217f19871d08

RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-dev \
    python3-venv \
    curl \
    python3-fiona \
    python3-rasterio \
    python3-shapely \
    python3-geopandas \
    python3-pyproj \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv --system-site-packages
ENV PATH="/opt/venv/bin:$PATH"

# Keep api/requirements.txt as the source of truth, but skip packages that are
# already provided by the distro geospatial stack to avoid slow source builds.
COPY api/requirements.txt .
RUN pip install --upgrade pip && \
    grep -Ev '^(rasterio==.*|geopandas|fiona|pyproj|shapely)$' requirements.txt > docker-requirements.txt && \
    pip install -r docker-requirements.txt && \
    rm docker-requirements.txt && \
    rm requirements.txt

# create a folder for the application
WORKDIR /app
COPY ./shared /app/shared
COPY ./api/src /app/api/src
# COPY ./run.py /app/run.py

# Create mount points with appropriate permissions
RUN mkdir -p /gadm_data && \
    chmod 755 /gadm_data

# set the working directory
WORKDIR /app

# run the application
#CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
CMD ["python", "api/src/run.py", "server"]
