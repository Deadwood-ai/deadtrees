# Debug Dataset Command

**Usage:** `@debug-dataset <dataset_id>` (e.g., `@debug-dataset 3904`)

## 🚨 CRITICAL RULES
- **READ-ONLY ANALYSIS** - Never modify database, files, or configurations during investigation
- **MCP ONLY** - All database queries use MCP tools (never direct DB connection)
- **NEVER USE SSH** 
- **Output inline** - Present findings in chat (no file writing)

## 🔄 **Processing Order of Operations**

Tasks execute in this **strict order** (see `@processor-pipeline.mdc` for details):

1. **ODM** (if raw drone images) → Generates ortho from raw images
2. **GeoTIFF Standardization** → Standardizes/tiles ortho (stays LOCAL, not pushed back)
3. **Metadata** → GADM, biome, phenology
4. **COG** → Cloud-optimized GeoTIFF
5. **Thumbnail** → Preview image
6. **Deadwood** → Deadwood segmentation
7. **Tree Cover** → Forest cover segmentation

**Key Point:** Standardized ortho stays in processor container temp dir. All subsequent tasks (COG, thumbnail, segmentation) use this local standardized file. Original preserved at `/data/archive/`.

---

## 📊 Quick Reference: Tables by Processing Stage

| Stage | Primary Tables | Check For |
|-------|----------------|-----------|
| **Upload** | `v2_datasets`, `v2_statuses`, `v2_raw_images` | file_name, user_id, is_upload_done |
| **ODM** | `v2_raw_images`, `v2_orthos` | raw_image_count, camera_metadata, RTK data, ortho created |
| **GeoTIFF** | `v2_orthos`, `v2_orthos_processed` | ortho_info, CRS, bbox, standardization |
| **COG** | `v2_cogs`, `v2_orthos_processed` | cog_file_size, compression, tiling |
| **Thumbnail** | `v2_thumbnails` | thumbnail_file_size, processing_runtime |
| **Metadata** | `v2_metadata` | GADM, biome, phenology fields |
| **Deadwood** | `v2_labels`, `v2_deadwood_geometries` | label_data='deadwood', geometry count |
| **Treecover** | `v2_labels`, `v2_forest_cover_geometries` | label_data='forest_cover', geometry count |

---

## Investigation Protocol (Execute in Order)

### 🔍 PHASE 1: CRITICAL STATUS (MCP - Required)
**1.1 Dataset Status & Error** (MCP)
```sql
SELECT d.id, d.file_name, d.user_id, d.created_at,
  s.current_status, s.has_error, s.error_message,
  s.is_upload_done, s.is_odm_done, s.is_ortho_done, s.is_cog_done, 
  s.is_thumbnail_done, s.is_deadwood_done, s.is_forest_cover_done, s.is_metadata_done,
  s.updated_at as status_updated
FROM v2_datasets d 
JOIN v2_statuses s ON d.id = s.dataset_id 
WHERE d.id = <dataset_id>;
```
→ **Identify:** Failing stage (first false flag), error message, stuck duration

**1.2 Error Logs** (MCP)
```sql
SELECT level, message, category, created_at
FROM v2_logs
WHERE dataset_id = <dataset_id> AND level IN ('ERROR', 'CRITICAL')
ORDER BY created_at DESC LIMIT 20;
```
→ **Identify:** First error, error pattern, timeline

**1.3 Processing Timeline** (MCP)
```sql
SELECT MIN(created_at) as start_time, MAX(created_at) as end_time,
  EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))/60 as duration_min
FROM v2_logs WHERE dataset_id = <dataset_id>;
```
→ **Identify:** Processing window for resource analysis

---

### 🔎 PHASE 2: FILE & PROCESSING DETAILS (MCP)
**Query all relevant tables based on failing stage from 1.1:**

**⚠️ IMPORTANT: File Size Units**
- `ortho_file_size` and `cog_file_size` are stored in **MB** (not bytes, despite field name)
- Example: `ortho_file_size: 7366` = 7,366 MB ≈ 7.2 GB
- To verify actual file size on disk: use `/home/jj1049/mount_storage_server/` (local mount of storage server)

**2.1 Raw Images Metadata** (if ODM pipeline or ZIP upload)
```sql
SELECT dataset_id, raw_image_count, raw_image_size_mb, 
  has_rtk_data, rtk_precision_cm, rtk_quality_indicator, rtk_file_count,
  camera_metadata, raw_images_path
FROM v2_raw_images WHERE dataset_id = <dataset_id>;
```
→ **Check:** Image count, RTK data, camera make/model, EXIF metadata

**2.2 Ortho (Original Upload or ODM Output)**
```sql
SELECT dataset_id, ortho_file_name, ortho_file_size, bbox, 
  ortho_info, ortho_upload_runtime, ortho_processing_runtime, created_at
FROM v2_orthos WHERE dataset_id = <dataset_id>;

-- File info check: dimensions, CRS, tiling
SELECT ortho_file_size as size_mb,
  ortho_info->'Profile'->>'Width' as width,
  ortho_info->'Profile'->>'Height' as height,
  ortho_info->'Profile'->>'Tiled' as is_tiled,
  ortho_info->'GEO'->>'CRS' as crs,
  ortho_info->'COG_errors' as cog_errors
FROM v2_orthos WHERE dataset_id = <dataset_id>;
```
→ **Check:** CRS validity, bbox validity, COG errors, tiling status (important for large images!)
→ **NOTE:** `ortho_file_size` is in **MB**. E.g., 7366 = 7.2 GB. Verify actual size: `ls -lh /home/jj1049/mount_storage_server/archive/<dataset_id>_ortho.tif`

**2.3 Orthos Processed** (standardized GeoTIFF metadata - LOCAL file only)
```sql
SELECT dataset_id, file_name, file_size,
  ortho_processing_runtime, created_at
FROM v2_orthos_processed WHERE dataset_id = <dataset_id>;
```
→ **Check:** Standardization completed, processing time reasonable
→ **NOTE:** This table stores metadata for the standardized/tiled ortho that stays LOCAL in processor temp dir. The file is NOT pushed back to `/data/archive/`. All downstream tasks (COG, thumbnail, segmentation) use this local standardized file.

**2.4 COG (Cloud Optimized GeoTIFF)**
```sql
SELECT dataset_id, cog_file_name, cog_file_size, cog_info, 
  cog_processing_runtime, created_at
FROM v2_cogs WHERE dataset_id = <dataset_id>;
```
→ **Check:** COG created, file size > 0, processing time, tiling/compression info (cog_info contains tiling details)
→ **NOTE:** `cog_file_size` is in **MB**. E.g., 1108 = 1.1 GB. Verify actual size: `ls -lh /home/jj1049/mount_storage_server/cogs/<dataset_id>_cog.tif`

**2.5 Thumbnail**
```sql
SELECT dataset_id, thumbnail_file_name, thumbnail_file_size, 
  thumbnail_processing_runtime, created_at
FROM v2_thumbnails WHERE dataset_id = <dataset_id>;
```
→ **Check:** Thumbnail generated, file size reasonable (typically < 1MB)

**2.6 Metadata** (GADM, biome, phenology)
```sql
SELECT dataset_id, metadata, processing_runtime, version, created_at
FROM v2_metadata WHERE dataset_id = <dataset_id>;

-- Extract specific metadata fields
SELECT dataset_id,
  metadata->'gadm' as gadm_data,
  metadata->'biome' as biome_data,
  metadata->'phenology' as phenology_data
FROM v2_metadata WHERE dataset_id = <dataset_id>;
```
→ **Check:** GADM admin levels present, biome classification, phenology curve

**2.7 Labels & Geometries** (segmentation results)
```sql
-- Get all labels
SELECT l.id, l.dataset_id, l.label_source, l.label_type, l.label_data, 
  l.label_quality, l.created_at,
  COUNT(DISTINCT dg.id) as deadwood_geom_count,
  COUNT(DISTINCT fg.id) as forest_geom_count
FROM v2_labels l
LEFT JOIN v2_deadwood_geometries dg ON l.id = dg.label_id
LEFT JOIN v2_forest_cover_geometries fg ON l.id = fg.label_id
WHERE l.dataset_id = <dataset_id>
GROUP BY l.id, l.dataset_id, l.label_source, l.label_type, l.label_data, 
  l.label_quality, l.created_at;

-- Sample geometries (check structure)
SELECT label_id, ST_AsText(geometry) as geom_wkt, properties
FROM v2_deadwood_geometries 
WHERE label_id IN (SELECT id FROM v2_labels WHERE dataset_id = <dataset_id>)
LIMIT 3;

SELECT label_id, ST_AsText(geometry) as geom_wkt, properties
FROM v2_forest_cover_geometries 
WHERE label_id IN (SELECT id FROM v2_labels WHERE dataset_id = <dataset_id>)
LIMIT 3;
```
→ **Check:** Labels created, geometry counts, model predictions vs manual labels

---

### 🌍 PHASE 3: SIMILAR ERRORS & USER CONTEXT (MCP)

**3.1 Similar Errors (Last 7 Days)**
```sql
-- Count similar errors by stage
SELECT COUNT(*) as count, error_message
FROM v2_statuses s
JOIN v2_datasets d ON s.dataset_id = d.id
WHERE s.has_error = true
AND d.created_at > NOW() - INTERVAL '7 days'
AND s.is_odm_done = (SELECT is_odm_done FROM v2_statuses WHERE dataset_id = <dataset_id>)
AND s.is_ortho_done = (SELECT is_ortho_done FROM v2_statuses WHERE dataset_id = <dataset_id>)
GROUP BY error_message
ORDER BY count DESC LIMIT 5;
```
→ **Identify:** Systemic vs isolated issue

**3.2 User Context**
```sql
SELECT u.email, COUNT(d.id) as total_datasets,
  COUNT(*) FILTER (WHERE s.has_error = true) as errors
FROM auth.users u
JOIN v2_datasets d ON u.id = d.user_id
LEFT JOIN v2_statuses s ON d.id = s.dataset_id
WHERE u.id = (SELECT user_id FROM v2_datasets WHERE id = <dataset_id>)
GROUP BY u.id, u.email;
```
→ **Identify:** User email, dataset count, error rate

**3.3 Queue Status**
```sql
SELECT task_types, is_processing, current_position
FROM v2_queue WHERE dataset_id = <dataset_id>;
```
→ **Identify:** Stuck in queue?

---

### 💻 PHASE 4: LOCAL SYSTEM INVESTIGATION

**⚠️ IMPORTANT: Storage Server Files Available Locally**
The production storage server is mounted at `/home/jj1049/mount_storage_server`. Use this to explore actual uploaded files:
```bash
# Archive files (original uploads)
ls -lh /home/jj1049/mount_storage_server/archive/<dataset_id>_ortho.tif

# COGs
ls -lh /home/jj1049/mount_storage_server/cogs/<dataset_id>_cog.tif

# Thumbnails
ls -lh /home/jj1049/mount_storage_server/thumbnails/<dataset_id>_thumbnail.png

# Raw images (for ZIP/ODM uploads)
ls -lh /home/jj1049/mount_storage_server/raw_drone_images/<dataset_id>/

# Verify file integrity
gdalinfo /home/jj1049/mount_storage_server/archive/<dataset_id>_ortho.tif | head -30
```
This mount corresponds to `/data/` on the storage server.

**4.1 Docker Containers** (Local)
```bash
# Check containers for this dataset
docker ps -a --filter "label=dataset_id=<dataset_id>"

# Recent processor logs
docker ps -a --filter "name=processor" --format "{{.ID}}" | head -1 | xargs docker logs --tail 100 2>&1 | grep -i "<dataset_id>\|error\|failed"

# Check ODM/TCD containers (if relevant to failing stage)
docker ps -a --filter "ancestor=opendronemap/odm" --format "table {{.ID}}\t{{.Status}}\t{{.CreatedAt}}" | head -5
docker ps -a --filter "name=tcd_" --format "table {{.ID}}\t{{.Status}}\t{{.CreatedAt}}" | head -5

# Orphaned volumes
docker volume ls --filter "name=<dataset_id>"
```
→ **Identify:** Zombie containers, exit codes, orphaned volumes

**4.2 Server Resources** (Local - use processing time window from 1.3)
```bash
# CPU, memory, load during processing window
# Convert times from 1.3: 2024-10-14 14:30:00 → DAY=14, START=14:30:00
LC_ALL=C sar -u -f /var/log/sysstat/sa<DAY> -s <START> -e <END> | tail -10
LC_ALL=C sar -r -f /var/log/sysstat/sa<DAY> -s <START> -e <END> | tail -10
LC_ALL=C sar -q -f /var/log/sysstat/sa<DAY> -s <START> -e <END> | tail -10

# Check for OOM kills
journalctl -k --since '<START_DATETIME>' --until '<END_DATETIME>' | grep -i 'oom\|killed'
```
→ **Identify:** CPU >85%, iowait >5%, memory >90%, OOM events

**4.3 Disk & Files** (Local)
```bash
df -h /data
du -sh /data/processing 2>/dev/null
find /data/processing -name "*<dataset_id>*" -ls 2>/dev/null
```
→ **Identify:** Disk space issues, stuck files

---

### 📝 PHASE 5: CODE ANALYSIS

**5.1 Identify Failing Process** (Based on status flags from 1.1)
- `is_odm_done: false` → `processor/src/process_odm.py`
- `is_ortho_done: false` → `processor/src/process_geotiff.py`
- `is_cog_done: false` → `processor/src/process_cog.py`
- `is_thumbnail_done: false` → `processor/src/process_thumbnail.py`
- `is_metadata_done: false` → `processor/src/process_metadata.py`
- `is_deadwood_done: false` → `processor/src/process_deadwood_segmentation.py`
- `is_forest_cover_done: false` → `processor/src/process_treecover_segmentation.py`

**5.2 Read & Analyze Code**
- Read the failing process file
- Trace through full stack and dependencies
- Check error handling and logging
- Search for error message in codebase
- Check recent commits

```bash
grep -rn "<error_keyword>" processor/src/
git log --oneline -n 10 -- processor/src/process_<stage>.py
```

**5.3 Test Coverage**
```bash
ls processor/tests/test_process_<stage>.py
grep -n "def test_" processor/tests/test_process_<stage>.py
```
→ **Identify:** Missing test coverage for this failure

---

### 📊 PHASE 6: ROOT CAUSE ANALYSIS & RECOMMENDATIONS

**Present findings inline with this structure:**

## 🔍 Root Cause Analysis: Dataset `<dataset_id>`

### ✅ FACTS (Confirmed Evidence)
**Dataset Overview:**
- ID: `<id>`, File: `<filename>`, User: `<email>` (<total_datasets> datasets, <error_count> errors)
- Created: `<created_at>`, Platform: `<platform>`
- Failure Stage: `<stage>` (first false flag: `is_*_done`)
- Error Message: `<error_message>` (or null if missing)
- Processing Time: `<duration>` min (from `<start>` to `<end>`)

**Pipeline Data:**
- Raw Images: `<count>` images, `<size>` MB, RTK: `<yes/no>`, Camera: `<make/model>`
- Ortho: `<filename>`, `<size>` MB, `<width>x<height>` px, CRS: `<crs>`, bbox: `<bbox>`
- Ortho Processed: `<exists yes/no>`, `<size>` MB
- COG: `<exists yes/no>`, `<size>` MB, compression: `<method>`
- Thumbnail: `<exists yes/no>`, `<size>` KB
- Metadata: GADM: `<present/missing>`, Biome: `<present/missing>`, Phenology: `<present/missing>`
- Labels: `<count>` labels, Deadwood geoms: `<count>`, Forest geoms: `<count>`

**System State:**
- Similar Errors: `<count>` in last 7 days (systemic/isolated)
- Container Status: `<exit_code/status>`
- Server Resources: CPU: `<avg>%`, Memory: `<avg>%`, Load: `<avg>`, OOM: `<yes/no>`
- Disk Space: `/data` `<used>%`, processing: `<size>`
- Queue Status: `<in_queue yes/no>`, position: `<pos>`

### ⚠️ ASSUMPTIONS (Inferred)
- Probable Root Cause: `<hypothesis>`
- Contributing Factors: `<list>`
- Why Error Message Incomplete: `<reason>`

### 🎯 ROOT CAUSE
**Primary:** `<direct cause>`

**Common Patterns:**
- File corruption (tiny size vs dimensions)
- Missing/invalid CRS
- Memory exhaustion (OOM)
- Disk space full
- Container crash
- Code bug (unhandled exception)
- Data quality (invalid coords, missing EXIF)

**Contributing Factors:** `<list>`

**Severity:** Isolated / Systemic

---

### ✅ IMMEDIATE NEXT STEPS (DO NOT EXECUTE - SUGGEST ONLY)

**Update DB to rerun dataset**
- give the sql to update v2_status and v2_queue table in db to add the dataset to the processing queue again. 
- provide the sql to the users to do this, dont run yourselve.

**Option 2: Manual Investigation**
1. Check file exists on storage: `<command>`
2. Verify file integrity: `<command>`
3. [Additional steps]

**Prerequisites:**
- [ ] Fix identified root cause first
- [ ] Verify system resources available
- [ ] Confirm no zombie containers/volumes

---

### 🛡️ PREVENTION & IMPROVEMENTS

**Code Changes Needed:**
- File: `processor/src/process_<stage>.py`
- Add: `<specific error handling>`
- Improve: `<specific validation>`
- [Line numbers if applicable]

**Logging Enhancements:**
- Add: `<missing log info>`
- Include: `<stack trace/file size/memory>`
- Category: `<category>`

**Test Coverage:**
- Missing test: `test_process_<stage>_<scenario>()`
- Test file: `processor/tests/test_process_<stage>.py`
- Scenario: `<failure scenario>`

**Infrastructure:**
- Add: `<monitoring/alerting>`
- Improve: `<resource limits/health checks>`

---

### 📋 EXECUTION CHECKLIST

**Completed:**
- [x] MCP database queries (no direct DB access)
- [x] Local system investigation
- [x] Code analysis and dependency tracing
- [x] Test coverage check
- [x] Similar error pattern analysis
- [x] Facts vs assumptions separated
- [x] **READ-ONLY** analysis (no modifications made)

**If User Wants to Fix:**
- [ ] User confirms root cause analysis
- [ ] User implements code changes
- [ ] User adds regression test
- [ ] User reruns dataset via API
- [ ] User monitors result

