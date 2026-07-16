# Start with a pinned GDAL image so Python/GDAL don't drift underneath the processor.
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.10.3@sha256:b50822a4059629f6a579908584e25e6adccfc70a57914290dd01217f19871d08 AS builder

# The pinned GDAL image currently carries an Apache Arrow apt source whose
# signing key has expired. The processor does not use that apt source.
RUN rm -f /etc/apt/sources.list.d/apache-arrow*.list /etc/apt/sources.list.d/apache-arrow*.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-dev \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set environment variables for GDAL
RUN echo "GDAL_VERSION=$(gdal-config --version)" >> /etc/environment
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

# Set up the application maintaining local structure
WORKDIR /app
RUN mkdir -p /data

# Keep dependency versions in processor/requirements.txt. Production amd64
# builds default to CUDA 12.1 wheels; CPU CI overrides only the wheel source.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121
COPY processor/requirements.txt /app/processor/requirements.txt
RUN grep -E '^(torch|torchvision)==' /app/processor/requirements.txt > /tmp/torch-requirements.txt && \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        pip3 install --no-cache-dir --index-url "${TORCH_INDEX_URL}" \
            -r /tmp/torch-requirements.txt; \
    else \
        pip3 install --no-cache-dir -r /tmp/torch-requirements.txt; \
    fi && \
    grep -Ev '^(torch|torchvision)(==.*)?$' /app/processor/requirements.txt > /tmp/docker-requirements.txt && \
    pip3 install --no-cache-dir -r /tmp/docker-requirements.txt && \
    rm /tmp/torch-requirements.txt /tmp/docker-requirements.txt && \
    python -m pip check

FROM ghcr.io/osgeo/gdal:ubuntu-full-3.10.3@sha256:b50822a4059629f6a579908584e25e6adccfc70a57914290dd01217f19871d08 AS runtime

RUN rm -f /etc/apt/sources.list.d/apache-arrow*.list /etc/apt/sources.list.d/apache-arrow*.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Set environment variables for GDAL
RUN echo "GDAL_VERSION=$(gdal-config --version)" >> /etc/environment
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

# Set up the application maintaining local structure
WORKDIR /app
RUN mkdir -p /data

# Copy production application files
COPY ./processor/src /app/processor/src
COPY ./shared/*.py /app/shared/
COPY ./shared/testing/safety.py /app/shared/testing/safety.py

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

FROM runtime AS test

COPY processor/requirements-test.txt /tmp/requirements-test.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements-test.txt && \
    python -m pip check && \
    rm /tmp/requirements-test.txt

COPY ./processor/tests /app/processor/tests
COPY ./shared/testing /app/shared/testing
COPY pytest.ini /app/pytest.ini
COPY .dockerignore /app/.dockerignore

FROM runtime AS production
