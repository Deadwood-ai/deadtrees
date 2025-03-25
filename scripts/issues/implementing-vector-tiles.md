# Implementing Efficient Visualization and Editing of Large Vector Data

## Current Situation

Currently, vector data (deadwood segmentation, tree cover) is stored as JSONB in Supabase tables and loaded on page load. This approach doesn't scale well with large datasets, as predictions can reach 500MB-1GB in size.

## Problem Statement

We need a vector tile streaming solution that enables:

1. Efficient visualization of large vector datasets
2. Real-time editing capabilities
3. Version control and audit trail for edits
4. Commenting system for individual polygons
5. Integration with existing Supabase infrastructure

## Technical Requirements

- Support for datasets >500MB
- Fast visualization performance (<200ms tile load time)
- Minimal additional server infrastructure
- Real-time editing capabilities
- Edit tracking and versioning
- Comment system for polygons
- Integration with existing Supabase system

## Solution Options

### 1. PMTiles (Protomaps Tiles)

PMTiles is a single-file archive format for map tiles. It's designed for efficient delivery of vector and raster map data over HTTP using standard web servers.

#### How it works

- Stores map data in a single file that can be hosted on any static file server
- Uses range requests to fetch only needed portions of the file
- Client-side libraries handle tile requests and caching

#### Advantages

- File-based, no additional server required
- Efficient for static datasets
- Good browser caching support
- Simple deployment (just host the file)
- Works well with CDNs

#### Disadvantages

- Not suitable for dynamic updates
- Requires full regeneration on data changes
- Limited database integration options
- No built-in editing capabilities

### 2. MBTiles (Mapbox Tiles)

MBTiles is a specification for storing tiled map data in SQLite databases. It's widely used in the geospatial industry and supported by many tools.

#### How it works

- Stores tiles in a SQLite database
- Organizes data by zoom level and coordinates
- Requires a server to serve tiles to clients

#### Advantages

- Well-established format
- Good tool ecosystem
- Efficient storage
- Supports both vector and raster tiles
- Many existing tools for creation and serving

#### Disadvantages

- Requires separate server
- Not optimal for dynamic data
- Complex database integration
- Additional infrastructure needed

### 3. PostGIS with ST_AsMVT (Recommended)

PostGIS is a spatial database extender for PostgreSQL, adding support for geographic objects. ST_AsMVT is a function that generates Mapbox Vector Tiles directly from PostGIS data.

#### How it works

- Uses PostgreSQL with PostGIS extension
- Generates vector tiles on-demand from spatial data
- Integrates directly with existing database
- Supports real-time updates and editing

#### Advantages

- Dynamic tile generation
- Native database integration
- Real-time editing support
- Built-in spatial indexing
- Version control capabilities
- Efficient query optimization
- Direct integration with existing data
- Supports complex spatial queries
- Can leverage PostgreSQL's rich feature set

#### Disadvantages

- Increased storage requirements
- May require self-hosted Supabase instance
- Higher computational requirements
- Needs careful query optimization

## Implementation Considerations

### Performance Optimization

- Implement proper spatial indexing
  - GIST index on geometry columns
  - B-tree indexes on frequently queried columns
- Precompute tile_ids for faster lookup
- Consider caching strategies
  - Tile cache for frequently accessed areas
  - Cache invalidation on edits

### Infrastructure

Two options:

1. Continue with Supabase hosted solution

   - Pros: Managed service, less maintenance
   - Cons: Higher costs, less control
   - Estimated costs: 0.12 per additional GB
   - Currently only 1GB RAM, 2 Cores

2. Self-host Supabase on storage server (recommended)
   - More control over resources
   - Better cost efficiency
   - Sufficient computing power
   - But we need to manage and setup the system.

## Questions to Resolve

- Is selfosting supabase a viable option?

Assignees: @mmaelicke
