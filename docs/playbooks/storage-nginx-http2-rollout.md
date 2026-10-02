# Storage nginx HTTP/2 Rollout (Host nginx)

Production nginx on the storage server runs on the host from a server-local
config; `nginx/api-conf/storage-server.conf` in this repository is the
reference, not the live file (see
[dataset access rollout](dataset-access-rollout.md)). Enabling HTTP/2 is
therefore a manual production change that needs explicit approval.

## Why

The maps read Cloud-Optimized GeoTIFFs with HTTP range requests, dozens per
view. Over HTTP/1.1 a browser sends at most six at a time to one host and opens
six TLS connections to do it. Over HTTP/2 all of them share one connection.

Measured with 48 concurrent 64 KB range requests to one COG at 200 ms round
trip: 2.1 s over HTTP/1.1, 0.46 s over HTTP/2. In a three-level zoom on a
dataset page the difference stayed within run-to-run noise, because one zoom
step asks for fewer tiles at once; expect the gain on large or fast pans and on
high-latency connections.

## Change

In the live `server` block for `data2.deadtrees.earth`, add `http2` to both TLS
listeners:

```nginx
listen 443 ssl http2;
listen [::]:443 ssl http2;
```

This is the syntax for the installed nginx 1.24. From nginx 1.25.1 the
separate `http2 on;` directive replaces the `listen` parameter.

## Steps

1. Keep a copy of the current config file.
2. Edit the two `listen` lines, then run `nginx -t`.
3. `systemctl reload nginx`. A reload keeps running uploads and downloads on
   their existing connections.
4. Verify:

   ```bash
   curl -sI --http2 -o /dev/null -w '%{http_version}\n' https://data2.deadtrees.earth/
   ```

   prints `2`. Then load a public dataset page and `/deadtrees`, start an
   upload, and download a dataset.

Rollback: restore the copy and reload.
