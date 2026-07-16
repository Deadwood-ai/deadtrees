# Start from the same GDAL image we use for processor so arm64 geospatial builds
# can reuse distro-provided Python bindings instead of compiling from source.
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.10.3@sha256:b50822a4059629f6a579908584e25e6adccfc70a57914290dd01217f19871d08 AS runtime

# The pinned GDAL image currently carries an Apache Arrow apt source whose
# signing key has expired. DeadTrees does not install Arrow from that source,
# so remove it before refreshing Ubuntu package metadata.
RUN rm -f /etc/apt/sources.list.d/apache-arrow*.list /etc/apt/sources.list.d/apache-arrow*.sources && \
    apt-get update && apt-get install -y \
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
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        pip install --index-url https://download.pytorch.org/whl/cpu \
            torch==2.4.1 torchvision==0.19.1; \
    else \
        pip install torch==2.4.1 torchvision==0.19.1; \
    fi && \
    grep -Ev '^(rasterio|geopandas|fiona|pyproj|shapely|torch|torchvision)(==.*)?$' requirements.txt > docker-requirements.txt && \
    pip install -r docker-requirements.txt && \
    rm docker-requirements.txt && \
    rm requirements.txt

# create a folder for the application
WORKDIR /app
COPY ./shared/*.py /app/shared/
COPY ./shared/testing/safety.py /app/shared/testing/safety.py
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

FROM runtime AS test

COPY api/requirements-test.txt /tmp/requirements-test.txt
RUN pip install --no-cache-dir -r /tmp/requirements-test.txt && \
    rm /tmp/requirements-test.txt

COPY ./api/tests /app/api/tests
COPY ./shared/testing /app/shared/testing
COPY ./shared/tests /app/shared/tests
COPY pytest.ini /app/pytest.ini

FROM runtime AS production
