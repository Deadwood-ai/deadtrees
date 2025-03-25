# Schema Changes v1 to v2

The current database schema (v1) is spread across multiple tables with complex relationships and some redundancy:

## Current schema

1. **Multiple Processing Tables (tables which are updated infrequently)**

   - `v1_datasets`: Core table with basic file info, is updated on every status change. Also since i use
   - `v1_metadata`: Separate metadata table
   - `v1_geotiff_info`: Technical metadata
   - `v1_cogs`, `v1_thumbnails`: Processing results
   - `v1_labels`: Label data

2. **Development Tables**

   - Duplicate tables with `dev_` prefix
   - Separate schemas for development and production
   - Increases maintenance overhead

3. **Status Tracking**
   - Status tracking spread across multiple tables
   - Complex state management
   - No clear processing history

```mermaid
classDiagram

    class Status {
        <<enumeration>>
        pending
        processing
        errored
        processed
        audited
        audit_failed
        cog_processing
        thumbnail_processing
        cog_errored
        thumbnail_errored
        uploading
        uploaded
        deadwood_prediction
        deadwood_errored
    }

    class v1_datasets {
        bigint id PK
        text file_name
        bigint file_size
        box2d bbox
        Status status
        uuid user_id FK
        timestamp created_at
        numeric copy_time
        text sha256
        text file_alias
    }

    class v1_cogs {
        bigint dataset_id PK, FK
        text cog_folder
        text cog_name
        text cog_url
        bigint cog_size
        double precision runtime
        uuid user_id FK
        text compression
        integer overviews
        integer resolution
        integer blocksize
        text compression_level
        text tiling_scheme
        timestamp created_at
    }

    class v1_geotiff_info {
        integer dataset_id PK, FK
        varchar(255) driver
        integer size_width
        integer size_height
        real file_size_gb
        text crs
        varchar(50) crs_code
        varchar(255) geodetic_datum
        double precision pixel_size_x
        double precision pixel_size_y
        integer block_size_x
        integer block_size_y
        boolean is_tiled
        varchar(50) compression
        varchar(50) interleave
        boolean is_bigtiff
        integer band_count
        varchar[] band_types
        varchar[] band_interpretations
        double precision[] band_nodata_values
        double precision origin_x
        double precision origin_y
        jsonb extra_metadata
        timestamp created_at
    }
    class LabelSource {
        <<enumeration>>
        visual_interpretation
        model_prediction
        fixed_model_prediction
    }

    class LabelType {
        <<enumeration>>
        point_observation
        segmentation
        instance_segmentation
        semantic_segmentation
    }

    class v1_labels {
        bigint id PK
        bigint dataset_id FK
        uuid user_id FK
        jsonb aoi
        jsonb label
        LabelSource label_source
        smallint label_quality
        timestamp created_at
        LabelType label_type
    }

    class v1_logs {
        bigint id PK
        timestamp created_at
        text name
        text level
        text message
        text origin
        integer origin_line
        uuid user_id FK
        bigint dataset_id FK
        text backend_version
    }

    v1_datasets --> v1_cogs : has
    v1_datasets --> v1_geotiff_info : has
    v1_datasets --> v1_labels : has
    v1_datasets --> v1_logs : has

```

## Proposed Table Schemas

1. **Static Dataset Information (v2_datasets)**

   - Datasets table contains only user input
   - No dynamic updates after creation
   - Serves as the central reference point
   - Is running on the storage server and initiated by the frontend

2. **Simplified Processing Tables (v2_orthos, v2_cogs, v2_thumbnails)**

   - Removed redundant columns
   - Consolidated metadata into JSON/JSONB fields (cog_info)
   - Clearer separation of concerns

3. **Improved Status Tracking (v2_statuses)**

   - Boolean flags for completion states
   - Simplified current status enum
   - Better error handling

4. **Removed separate metadata table**

   - Technical metadata moved to respective processing tables
   - User metadata stays in datasets table

5. **Remove dev tables**

   - Locally, I use the production schema for testing and development, without any data. So no need for dev tables anymore.

6. **Adding versioning for processes**

   - each process (ortho_conversion, cog_conversion, thumbnail_conversion, deadwood_segmentation, forest_cover_segmentation) will have a version number, which i will place in the repo together with a changelog. So if i update the process i will increment the version number and exapolin the changes in the changelog, i can easily see what has changed and what has been updated.

7. **Adding a changelog (as a markdown file in the repo)**

   - i will add a changelog to the repo, which will contain all the changes to the code, including schema changes.

## Key Changes

```mermaid
classDiagram

class v2_datasets {
    bigint id PK
    uuid user_id FK
    timestamp created_at
    text file_name
    License license
    Platform platform
    text project_id
    text[] authors
    smallint aquisition_year
    smallint aquisition_month
    smallint aquisition_day
    text additional_information
    text citation_doi
    access data_access
}
class v2_orthos {
    bigint dataset_id PK, FK
    text ortho_file_name
    integer version
    timestamp created_at
    bigint file_size
    box2d bbox
    text sha256
    jsonb ortho_info
    float ortho_upload_runtime
    boolean ortho_processing
    boolean ortho_processed
    float ortho_processing_runtime
}

class v2_cogs {
    bigint dataset_id PK, FK
    bigint file_size
    text cog_file_name
    text cog_path
    integer version
    timestamp created_at
    jsonb cog_info
    float cog_processing_runtime
}
class v2_thumbnails {
    bigint dataset_id PK, FK
    bigint file_size
    text thumbnail_file_name
    text thumbnail_path
    integer version
    timestamp created_at
    float thumbnail_processing_runtime
}
class v2_statuses {
    id bigint PK
    dataset_id bigint FK
    current_status StatusEnum
    is_upload_done BOOLEAN
    is_ortho_done BOOLEAN
    is_cog_done BOOLEAN
    is_thumbnail_done BOOLEAN
    is_deadwood_done BOOLEAN
    is_forest_cover_done BOOLEAN
    is_audited BOOLEAN
    has_error BOOLEAN
    error_message TEXT
    created_at TIMESTAMP
    updated_at TIMESTAMP
}

class v2_aois {
    id bigint PK
    dataset_id bigint FK
    user_id UUID FK
    geometry jsonb
    is_whole_image boolean
    image_quality smallint
    created_at timestamp
    updated_at timestamp
    notes text
}

class v2_labels {
    id bigint PK
    dataset_id bigint FK
    aoi_id bigint FK
    user_id UUID FK
    source LabelSource
    type LabelType
    label_quality smallint
    model_config jsonb
    timestamp created_at
    timestamp updated_at
}

class v2_label_geometries {
    id bigint PK
    label_id bigint FK
    geometry multipolygon
    jsonb properties
    timestamp created_at
}

class LabelSource {
    <<enumeration>>
    visual_interpretation
    model_prediction
    fixed_model_prediction
}

class LabelType {
    <<enumeration>>
    deadwood
    forest_cover
}
v2_datasets <-- v2_orthos
v2_datasets <-- v2_cogs
v2_datasets <-- v2_thumbnails
v2_datasets <-- v2_statuses


v2_datasets --> v2_aois
v2_datasets --> v2_labels
v2_aois --> v2_labels
v2_labels --> v2_label_geometries
```

## Status States

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> uploading
    uploading --> idle: error
    uploading --> idle: success

    idle --> ortho_processing
    ortho_processing --> idle: error/success

    idle --> cog_processing
    cog_processing --> idle: error/success

    idle --> thumbnail_processing
    thumbnail_processing --> idle: error/success

    idle --> deadwood_segmentation
    deadwood_segmentation --> idle: error/success

    idle --> forest_cover_segmentation
    forest_cover_segmentation --> idle: error/success

    idle --> audit_in_progress
    audit_in_progress --> idle: error/success
```

## How to structure the schema for the labels?

Some considernation from my side:

- for each label there needs to be a aoi. But what if there is none, e.g uploded data.
- I will implement a new performant vector visualisation approach which for each label stores the vectors as geometry as postgis geometry. One polygon as one row in the table. I will create a new schema for label geometrys, i will use to genereate vector tiles dynamically. So I will store the geomtry in a nother table not v2_labels.

class v2_status {
<<enumeration>>
idle
uploading
ortho_processing
cog_processing
thumbnail_processing
deadwood_segmentation
forest_cover_segmentation
audit_in_progress
}
