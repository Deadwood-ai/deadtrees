# Local Development Setup

This repository contains the API, processor, shared Python code, frontend, Supabase migrations, and the `deadtrees` development CLI.

## Prerequisites

- Docker Desktop or Docker Engine with `docker compose`
- Python 3.12+
- Node.js 20+ and `npm`
- Supabase CLI
- `make`, `curl`, and `unzip`

## First-Time Bootstrap

These are the steps that currently produce a working local setup from a fresh clone.

### 1. Clone with submodules

```bash
git clone https://github.com/Deadwood-ai/deadtrees.git
cd deadtrees
git submodule update --init --recursive
```

The `processor/src/deadwood_segmentation/deadtreesmodels` submodule is required. If it is missing, processor images will not build.

### 2. Create the Python environment and install the CLI

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -e ./deadtrees-cli[test]
```

This installs the `deadtrees` command used for local stack management and test execution.

### 3. Install frontend dependencies

```bash
npm --prefix frontend ci
```

### 4. Create local env files from the checked-in examples

```bash
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
```

The example values are set up for local Supabase CLI defaults and the local Docker test stack.

### 5. Start local Supabase

```bash
supabase start
```

Useful local endpoints after `supabase start`:

- API gateway: `http://127.0.0.1:54321`
- Postgres: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Studio: `http://127.0.0.1:54323`
- Mailpit: `http://127.0.0.1:54324`

If you need a clean local database:

```bash
supabase db reset
```

### 6. Download required local assets and test fixtures

```bash
make download-assets
```

This now downloads the fixtures required for the local API test suite:

- `assets/test_data/test-data.tif`
- `assets/test_data/test-data-small.tif`
- `assets/test_data/yanspain_crop_124_polygons.gpkg`
- `assets/test_data/raw_drone_images/test_no_rtk_3_images.zip`
- `assets/test_data/raw_drone_images/test_minimal_5_images.zip`
- `data/assets/dte_maps/*.tif` test clips
- model and GADM assets

### 7. Start the local development stack

```bash
deadtrees dev start
```

This builds and starts the local test/dev services, including:

- `api-test`
- `processor-test`
- `nginx`
- `mailpit`

To rebuild from scratch:

```bash
deadtrees dev start --force-rebuild
```

To stop the stack:

```bash
deadtrees dev stop
```

### 8. Start the frontend

```bash
npm --prefix frontend run dev
```

## What Should Work After Bootstrap

### Local services

- Frontend: `http://127.0.0.1:5173`
- API via nginx: `http://127.0.0.1:8080/api/v1/`
- API docs: `http://127.0.0.1:8080/api/v1/docs`
- Downloads docs: `http://127.0.0.1:8080/api/v1/download/docs`
- COGs: `http://127.0.0.1:8080/cogs/v1/`
- Thumbnails: `http://127.0.0.1:8080/thumbnails/v1/`
- Supabase Studio: `http://127.0.0.1:54323`

### Tests

Prefer the `deadtrees` CLI for tests and debugging.

```bash
source venv/bin/activate

# Full API suite
deadtrees dev test api

# Single API file
deadtrees dev test api api/tests/routers/test_download.py

# Processor suite
deadtrees dev test processor

# Frontend tests
npm --prefix frontend test
```

Current known-good local result:

- `deadtrees dev test api` passes end-to-end after the bootstrap steps above
- `npm --prefix frontend test` passes
- `deadtrees dev test processor` still needs additional processor-side follow-up and should not be treated as the first bootstrap smoke test yet

### Debugging tests

```bash
deadtrees dev debug api --test-path=api/tests/routers/test_download.py
deadtrees dev debug processor --test-path=processor/tests/test_processor.py
```

## Optional: Extra ODM Test Data

For the basic local API suite, `make download-assets` is enough.

If you want the larger locally generated ODM ZIP fixtures as well:

```bash
./scripts/create_odm_test_data.sh
```

This is optional and mostly useful for extra processor/ODM experiments.

## Processor test prerequisites

The processor integration suite uses SSH against the local `nginx` test container to mimic the storage server.
Generate the local test-only keypair once before running processor tests:

```bash
make setup-local-test-ssh
```

This writes an ignored keypair to `.local/ssh/processing-to-storage` and `.local/ssh/processing-to-storage.pub`.
If you prefer a different key location, set absolute paths in `LOCAL_TEST_SSH_PRIVATE_KEY_PATH` and
`LOCAL_TEST_SSH_PUBLIC_KEY_PATH` before running `docker compose -f docker-compose.test.yaml ...`.

## Project structure

```bash
/assets      - Downloaded data and models
  /gadm        - GADM geographic data
  /models      - ML models for deadwood segmentation
/test_data   - Test GeoTIFF files

/api         - FastAPI application
  /src       - Source code
  /tests     - API tests

/processor   - Data processing service
  /src       - Source code
  /tests     - Processor tests

/shared      - Shared code between API and processor
```


## API - Deployment

### Additional requirements

So far I found the following packages missing on the Hetzner ubuntu image:

```bash
apt install -y make unzip 
```

### Setup user

create a user for everyone to log in (using root)

```bash
useradd dendro
usermod -aG docker dendro
```

### Init git and download repo

Next upload SSH keys for developers to `home/dendro/.ssh/authorized_keys`
**Add Env variables to the key, to set the git user for each developer**

```
command="export $GIT_AUTHOR_NAME='yourname' && export $GIT_AUTHOR_EMAIL='your-email';exec $SHELL -l" key
```

Next change the `/home/dendro/.bashrc` to configure git, add to the end:

```
if  [[ -n "$GIT_AUTHOR_NAME" && -n "$GIT_AUTHOR_EMAIL" ]]; then
        git config --global user.name "$GIT_AUTHOR_NAME"
        git config --global user.email "$GIT_AUTHOR_EMAIL"
fi
```

Now, you can download the repo, including the private repo.

```bash
# Clone the repository
git clone git@github.com:deadtrees/deadwood-api.git
cd deadwood-api

# Initialize and update submodules
git submodule update --init --recursive
```

### Create a .env file with required environment variables:

On the Storage server, only the necessary env is set
```
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
```

### Download required assets:

```bash
# Create assets directory and download test data, models, and GADM data
make
```

### Build the repo

Optionally, you can alias the call of the correct docker compose file. Add to `.bashrc`

```
alias serv='docker compose -f docker-compose.api.yaml'
```

### Certificate issueing & renewal

The certbot service can be used to issue a certificate. For that, the ACME challange 
has to be served by a temporary nginx:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name default_server;
    server_tokens off;

    # add ACME challange for certbot
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
}
```

Then run the certbot service with all the mounts as configured in the `docker-compose.api.yaml`:

```bash
serv certbot certonly
```

Once successfull, you can start a cronjob to renew the certificate:

```bash
crontab -e
```

And add the following cronjob to run every Sunday night at 1:30. Currently we are not notified if this
fails and thus needs to be monitored for now:

```
30 1  * * 0 docker compose -f /apps/deadtrees/docker-compose.api.yaml run --rm certbot renew
```
