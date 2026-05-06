# Prepackaged Dataset Release Deploy

Use this checklist when deploying the prepackaged dataset download feature on
the storage/API server.

## Important Deployment Detail

The production storage server uses host Nginx managed by systemd. It does not
serve public traffic through the tracked Docker Nginx config.

- API code deploys automatically from `main` through `/apps/deadtrees/auto_deploy_api.sh`.
- Production Supabase migrations should be applied by the GitHub
  `Supabase Migrate On Merge` workflow, not by local/manual SQL.
- Host Nginx config is local-only at `/apps/deadtrees/nginx/conf/storage-server.conf`.
- `/etc/nginx/sites-enabled/storage-server.conf` points to that local-only file.
- The tracked `nginx/api-conf/storage-server.conf` is a reference for Docker-style
  Nginx and local review; production needs the same relevant blocks applied
  manually to the host Nginx file.

## Production Migration Policy

Avoid manual production Supabase migrations. They should happen through the
merge-to-main workflow so schema history, reviewed SQL, and deployment state
stay aligned.

If the GitHub migration workflow fails, stop before changing host Nginx and
diagnose the workflow failure first. For out-of-order migration errors such as
"local migration files to be inserted before the last migration on remote
database", prefer a reviewed follow-up migration with a newer timestamp or an
explicit workflow fix. Do not apply local SQL to production as a normal
workaround.

The direct Postgres port is the right target for migration tooling if the
workflow itself needs debugging. Application traffic and MCP checks may use the
pooler, but migration runners should avoid the transaction pooler.

## Before Updating Host Nginx

Confirm that the API has deployed the prepackaged router:

```bash
curl -fsS https://data2.deadtrees.earth/api/v1/prepackaged/packages
```

The response should be a JSON list of package definitions and versions.

Confirm that the API container is running the expected production settings:

```bash
ssh storage-server 'docker exec deadtrees-api-1 python -c "
from shared.settings import settings
print(settings.DEV_MODE)
print(settings.PREPACKAGED_DOWNLOAD_BASE_URL)
print(settings.PREPACKAGED_GRANTS_PER_USER_PER_DAY)
print(settings.PREPACKAGED_GRANTS_GLOBAL_PER_DAY)
"'
```

Expected:

```text
False
https://data2.deadtrees.earth/prepackaged/v1
5
30
```

If `PREPACKAGED_DOWNLOAD_BASE_URL` points to `localhost`, the API has not
deployed the production URL fix or the settings defaults are being evaluated
before environment parsing.

## Host Nginx Update

Edit the host Nginx config:

```bash
nano /apps/deadtrees/nginx/conf/storage-server.conf
```

Add the prepackaged `limit_*` zones and `log_format` at the top-level `http`
context, matching `nginx/api-conf/storage-server.conf`.

Inside the `data2.deadtrees.earth` server block, add the prepackaged auth and
static-file locations. On production, the auth upstream must use the host port:

```nginx
location = /_prepackaged_download_auth {
    internal;
    proxy_pass http://127.0.0.1:40831/prepackaged/grants/validate;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Download-Token $arg_token;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /prepackaged/v1/ {
    alias /data/assets/prepackaged_datasets_out/;
    autoindex off;
    try_files $uri =404;

    access_log /var/log/nginx/prepackaged_access.log prepackaged_safe;
    auth_request /_prepackaged_download_auth;
    limit_conn prepackaged_per_ip 1;
    limit_conn prepackaged_global 3;
    limit_req zone=prepackaged_start_rate burst=3 nodelay;
    limit_rate_after 512m;
    limit_rate 20m;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;

    add_header Accept-Ranges bytes;
    add_header Cache-Control "private, no-store";
    add_header 'Access-Control-Allow-Origin' 'https://deadtrees.earth' always;
    add_header 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Range,Content-Type' always;
}

location ^~ /assets/v1/prepackaged_datasets_out/ {
    autoindex off;
    return 404;
}
```

Test and reload host Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Production Smoke Test

Without a token, the signed route should be protected and should not return 404:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" \
  "https://data2.deadtrees.earth/prepackaged/v1/tree-cover-aerial-global_2026.04.17.zip"
```

Expected: `401`.

The old public asset path must stay blocked:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" \
  "https://data2.deadtrees.earth/assets/v1/prepackaged_datasets_out/"
```

Expected: `404`.

After a signed-in frontend download attempt, confirm the dedicated prepackaged
access log does not contain query-string tokens and the grant URL uses the
production storage host:

```bash
sudo tail -20 /var/log/nginx/prepackaged_access.log
sudo grep -R "token=" /var/log/nginx/prepackaged_access.log
```

Expected: the `tail` output logs `/prepackaged/v1/<file>.zip` without query
arguments, and the `grep` command returns no matches. In the browser, newly
minted download URLs should start with
`https://data2.deadtrees.earth/prepackaged/v1/`, never `http://localhost:8080/`.

## Bandwidth Context

On the current storage server, the public route uses `enp41s0`, which reports a
1 Gbit/s link:

```bash
ip route get 1.1.1.1
sudo ethtool enp41s0 | grep -E "Speed|Duplex|Link detected"
```

Nginx `limit_rate` uses bytes per second, not bits per second. The current
prepackaged package cap is:

```nginx
limit_conn prepackaged_global 3;
limit_rate_after 512m;
limit_rate 20m;
```

This allows roughly 20 MB/s per download after the first 512 MB, or about
60 MB/s across the three global concurrent package downloads. That leaves
headroom on the 1 Gbit/s public interface for COG, API, and normal website
traffic.
