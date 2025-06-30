---
description: Container orchestration and deployment patterns for DeadTrees project
globs: ["docker-compose*.yaml", "**/Dockerfile", "**/*.sh"]
alwaysApply: true
---

# Docker & Container Orchestration

## Container Architecture Overview

The DeadTrees project uses a multi-service containerized architecture with environment-specific orchestration.

## Docker Compose Files

### Environment-Specific Configurations

- **`docker-compose.test.yaml`**: Development and testing environment
- **`docker-compose.api.yaml`**: Production API deployment  
- **`docker-compose.processor.yaml`**: Production processing service

### Service Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   nginx         │    │   api           │    │   processor     │
│   (reverse      │    │   (FastAPI)     │    │   (data         │
│   proxy)        │    │                 │    │   processing)   │
│   Port: 80/443  │    │   Port: 40831   │    │   GPU-enabled   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   supabase      │
                    │   (PostgreSQL)  │
                    │   External      │
                    └─────────────────┘
```

## Development Environment

### Test Environment Services

```yaml
# docker-compose.test.yaml
services:
  api-test:      # Port 8017, Debug 5679
  processor-test: # Debug 5678, GPU support
  nginx:         # Port 8080, SSH 2222
  tests:         # End-to-end test runner
```

### Development Workflow

```bash
# Start development environment
deadtrees dev start

# Stop environment
deadtrees dev stop

# Force rebuild
deadtrees dev start --force-rebuild
```

### Resource Allocation (Development)
```yaml
deploy:
  resources:
    limits:
      cpus: '12'
      memory: '64G'
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

## Production Environment

### API Service Configuration

```yaml
# docker-compose.api.yaml
api:
  build:
    context: .
    dockerfile: api/Dockerfile
  restart: unless-stopped
  ports:
    - 127.0.0.1:40831:40831
  environment:
    UVICORN_ROOT_PATH: /api/v1
    UVICORN_PORT: 40831
    UVICORN_HOST: 0.0.0.0
    DEV_MODE: false
```

### Processor Service Configuration

```yaml
# docker-compose.processor.yaml
processor:
  network_mode: host
  runtime: nvidia
  deploy:
    resources:
      limits:
        cpus: '30'
        memory: '96G'
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
```

### Nginx Configuration

```yaml
nginx:
  build:
    context: ./nginx/api-conf
  restart: unless-stopped
  ports:
    - 80:80
    - 443:443
    - 2222:22  # SSH access
  depends_on:
    api:
      condition: service_healthy
```

## Volume Management

### Data Persistence

```yaml
volumes:
  # Production data mounting
  - /data:/data
  
  # Development code mounting (hot reload)
  - ./api:/app/api
  - ./shared:/app/shared
  - ./processor:/app/processor
  
  # Asset mounting
  - ./assets:/app/assets
  
  # Configuration mounting
  - ./nginx/api-conf:/etc/nginx/conf.d/:ro
```

### SSH Key Management

```yaml
# SSH key mounting for inter-service communication
volumes:
  - ~/.ssh/processing-to-storage:/tmp/ssh-keys/processing-to-storage:ro
  - ~/.ssh/processing-to-storage.pub:/tmp/ssh-keys/processing-to-storage.pub:ro
  - ~/.ssh/authorized_keys:/home/dendro/.ssh/authorized_keys:ro
```

## Health Checks

### API Health Check
```yaml
healthcheck:
  test: curl --fail http://127.0.0.1:40831/ || exit 1
  interval: 1m
  timeout: 10s
  retries: 5
  start_period: 1m30s
  start_interval: 1s
```

### Nginx Health Check
```yaml
healthcheck:
  test: ['CMD', 'service', 'nginx', 'status']
  interval: 30s
  timeout: 10s
  retries: 5
  start_period: 1m30s
  start_interval: 1s
```

## Environment Variables

### Common Environment Variables

```bash
# Database connection
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_KEY=${SUPABASE_KEY}

# Application settings
BASE_DIR=/data
PYTHONPATH=/app
DEV_MODE=false

# Monitoring
LOGFIRE_TOKEN=${LOGFIRE_TOKEN}
```

### Service-Specific Variables

#### API Service
```bash
UVICORN_ROOT_PATH=/api/v1
UVICORN_PORT=40831
UVICORN_HOST=0.0.0.0
GADM_DATA_PATH=/gadm_data/gadm_410.gpkg
```

#### Processor Service
```bash
STORAGE_SERVER_IP=data2.deadtrees.earth
STORAGE_SERVER_USERNAME=dendro
STORAGE_SERVER_DATA_PATH=${STORAGE_SERVER_DATA_PATH}
SSH_PRIVATE_KEY_PATH=/root/.ssh/processing-to-storage
SSH_PRIVATE_KEY_PASSPHRASE=${SSH_PRIVATE_KEY_PASSPHRASE}
NVIDIA_VISIBLE_DEVICES=all
NVIDIA_DRIVER_CAPABILITIES=all
```

## Dockerfile Patterns

### Multi-Stage Builds
Use multi-stage builds for optimized production images:

```dockerfile
# Build stage
FROM python:3.12-slim as builder
COPY requirements.txt .
RUN pip install --user -r requirements.txt

# Production stage
FROM python:3.12-slim
COPY --from=builder /root/.local /root/.local
COPY . /app
WORKDIR /app
```

### GPU Support
```dockerfile
# For processor service
FROM nvidia/cuda:11.8-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y python3 python3-pip
```

## Networking

### Network Configuration
```yaml
networks:
  default:
    name: deadwood_network
```

### Service Communication
- Services communicate within the Docker network
- External access via nginx reverse proxy
- SSH access for file transfers between services

## SSL/TLS Configuration

### Certbot Integration
```yaml
certbot:
  image: certbot/certbot:latest
  volumes:
    - ./certbot/www/:/var/www/certbot/:rw
    - ./certbot/conf/:/etc/letsencrypt:rw
  depends_on:
    - nginx
```

### SSL Certificate Mounting
```yaml
volumes:
  - ./certbot/conf:/etc/nginx/ssl/:ro
  - ./certbot/www:/var/www/certbot:ro
```

## Development vs Production Differences

### Development Features
- Code volume mounting for hot reload
- Debug port exposure
- Relaxed resource limits
- Local database connections

### Production Features
- Optimized container images
- Strict resource limits
- SSL/TLS termination
- Production database connections
- Health checks and restart policies

## Debugging and Troubleshooting

### Debug Port Mapping
```yaml
ports:
  - "5678:5678"  # Processor debug
  - "5679:5679"  # API debug
  - "5680:5680"  # CLI debug
```

### Container Inspection
```bash
# View running containers
docker-compose -f docker-compose.test.yaml ps

# View logs
docker-compose -f docker-compose.test.yaml logs api-test

# Execute commands in container
docker-compose -f docker-compose.test.yaml exec api-test bash
```

## Best Practices

1. **Use environment-specific compose files** for different deployment scenarios
2. **Implement proper health checks** for all services
3. **Use secrets management** for sensitive environment variables
4. **Mount volumes appropriately** for development vs production
5. **Configure resource limits** based on service requirements
6. **Use multi-stage builds** to optimize image sizes
7. **Implement proper logging** and monitoring
8. **Use restart policies** for production resilience 