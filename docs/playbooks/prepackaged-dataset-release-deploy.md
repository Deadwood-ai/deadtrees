# Prepackaged Dataset Release Deploy

Use this checklist when deploying the prepackaged dataset download feature on
the storage/API server.

## Important Deployment Detail

The production storage server uses host Nginx managed by systemd. It does not
serve public traffic through the tracked Docker Nginx config.

- API code deploys automatically from `main` through `/apps/deadtrees/auto_deploy_api.sh`.
- Host Nginx config is local-only at `/apps/deadtrees/nginx/conf/storage-server.conf`.
- `/etc/nginx/sites-enabled/storage-server.conf` points to that local-only file.
- The tracked `nginx/api-conf/storage-server.conf` is a reference for Docker-style
  Nginx and local review; production needs the same relevant blocks applied
  manually to the host Nginx file.

## Before Updating Host Nginx

Confirm that the API has deployed the prepackaged router:

```bash
curl -fsS https://data2.deadtrees.earth/api/v1/prepackaged/packages
```

The response should be a JSON list of package definitions and versions.

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
access log does not contain query-string tokens:

```bash
sudo tail -20 /var/log/nginx/prepackaged_access.log
sudo grep -R "token=" /var/log/nginx/prepackaged_access.log
```

Expected: the `tail` output logs `/prepackaged/v1/<file>.zip` without query
arguments, and the `grep` command returns no matches.
