# Dataset Access Rollout (Host nginx)

Production nginx on the storage server runs on the host from a server-local
config (`/apps/deadtrees/nginx/conf/storage-server.conf`); only the API container
auto-deploys from `main`. `nginx/api-conf/storage-server.conf` in this repository
is the reference for the blocks below, not the live file.

Dataset sharing (DT-1291) moves file authorization into the API. The host nginx
config does not deploy from git, so it changes by hand, in this order, with the
blocks in `nginx/api-conf/storage-server.conf` as the reference. Use the upstream
of the existing `/api/v1/` location wherever the reference says `api:40831`.
Each step is a production change that needs explicit approval; run
`nginx -t` before every reload and keep a copy of the previous file.

1. **Before merging (additive, safe on the old API):** add the
   `proxy_cache_path` line, the `/api/v1/(datasets/[0-9]+/files/|exports/)`
   location and the internal `/_protected_data/` location. Nothing outside can
   reach the internal location, and the old API never redirects into it.
2. **Merge:** the API, migration and frontend deploy as usual. Downloads now use
   signed `/api/v1/exports/...` links, which step 1 already serves.
3. **After the new API is live:** add the internal `/_authorize_public_file`
   location, put `auth_request /_authorize_public_file;` and `autoindex off;` on
   `/cogs/v1/` and `/thumbnails/v1/`, and replace `/downloads/v1` with
   `return 404;`. Doing this before step 2 would break every map, because the
   authorization route does not exist in the old API.
4. **Verify live:** a public dataset map loads; a private dataset's static COG
   URL returns 403; a shared private dataset renders for its reader; a dataset
   download completes through its signed link; an old `/downloads/v1/...` URL
   returns 404.

Rollback is the reverse order. `/reference/` is unchanged by this rollout.
