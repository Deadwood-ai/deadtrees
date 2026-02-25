# DeadTrees: An Open Platform for Automated Deadwood and Forest Cover Mapping from Aerial Imagery

## Overview

DeadTrees is an end-to-end, open-source platform for processing, analyzing, and visualizing high-resolution aerial orthophotos with a focus on deadwood detection and forest cover mapping. The system accepts two types of input data: pre-processed GeoTIFF orthomosaics and raw drone image collections (ZIP archives). Through an automated processing pipeline, each dataset is standardized, enriched with geospatial metadata, and analyzed using deep learning models for semantic segmentation of deadwood and tree cover.

The platform is designed for scalability and reproducibility, supporting community-driven data contribution through a web-based upload interface with chunked file transfer, and providing standardized, analysis-ready outputs including Cloud-Optimized GeoTIFFs (COGs), thumbnails, and vector-based segmentation labels.

## System Architecture

![DeadTrees System Architecture](docs/assets/deadtrees-dataflow-d2-post.svg)

*Figure 1: System architecture of the DeadTrees platform. GeoTIFF orthomosaics and raw drone images are uploaded, standardized, and processed through four parallel stages: COG generation, metadata enrichment (GADM, biome, phenology), and deep learning segmentation for deadwood (SegFormer-B5) and tree cover (TCD SegFormer-MIT-B5). Teal nodes indicate the ML models; edge labels show output types (files, records, labels). Raw drone images are optionally pre-processed through OpenDroneMap before entering the pipeline. Results are persisted to file storage (COG files) and PostgreSQL (metadata and segmentation labels), and delivered through a web application.*

## Processing Pipeline

The processing pipeline operates as an asynchronous task queue, with each dataset progressing through the following stages:

### 1. Data Ingestion

- **GeoTIFF Upload**: Pre-processed orthomosaics are uploaded directly via the chunked upload API (50 MB chunk size) and stored in the file archive.
- **Raw Drone Images**: ZIP archives containing raw drone imagery and optional RTK correction files are uploaded and processed through OpenDroneMap (ODM) to produce georeferenced orthomosaics via structure-from-motion photogrammetry.

### 2. GeoTIFF Standardization

All orthomosaics undergo standardization to ensure consistent tiling and coordinate reference system (CRS) alignment, producing analysis-ready raster data for downstream processing.

### 3. Metadata Enrichment

Each dataset is automatically enriched with geospatial context derived from the orthomosaic centroid coordinates:

- **GADM v4.1.0** — Administrative boundary levels (country, state/province, district)
- **WWF Terrestrial Ecoregions v2.0** — Biome classification
- **MODIS Phenology** — 366-day normalized vegetation phenology curve

### 4. Product Generation

- **Cloud-Optimized GeoTIFF (COG)** — Tiled, overviewed raster optimized for web-based streaming and visualization via HTTP range requests.
- **Thumbnail** — JPEG preview image for rapid visual assessment in the web interface.

### 5. Semantic Segmentation

Two deep learning models are applied to the standardized orthomosaic:

- **Deadwood Detection** — A SegFormer-B5 model trained on expert-annotated aerial imagery to identify standing and fallen deadwood at the individual object level.
- **Tree Cover Detection** — A TCD SegFormer-MIT-B5 model that delineates tree cover extent, providing complementary forest canopy information.

Both models produce polygon-based segmentation outputs stored as vector geometries in the database.

## Infrastructure

The platform is deployed across two physical servers:

- **API Server** — Hosts the FastAPI backend, NGINX reverse proxy (for API routing and static file serving of COGs, thumbnails, and downloads), and persistent file storage.
- **Processor Server** — Hosts the processing pipeline including ODM, GeoTIFF processing, and GPU-accelerated semantic segmentation. Data is transferred between servers via SSH.

All services are containerized using Docker Compose. Authentication and data management are handled through Supabase (PostgreSQL with row-level security).

## Web Application

The frontend is a React-based single-page application using OpenLayers for interactive map visualization. It provides:

- Dataset browsing with filtering, search, and tabular views
- Full-resolution COG rendering via WebGL tile layers
- Interactive deadwood and tree cover label visualization and editing
- Dataset upload with progress tracking and real-time status updates
- Quality audit workflow for expert review of model predictions

## Data Model

Each dataset record tracks:

| Component | Description |
|-----------|-------------|
| **Dataset** | User-provided metadata (platform, license, authors, acquisition date) |
| **Status** | Processing pipeline state (per-stage completion flags, error tracking) |
| **Ortho** | Original orthophoto file information (bounding box, file size, SHA-256) |
| **COG** | Cloud-optimized GeoTIFF metadata |
| **Metadata** | GADM, biome, and phenology enrichment data |
| **Labels** | Segmentation polygons (deadwood, tree cover) with source attribution |
| **Audit** | Quality assessment results from expert review |
