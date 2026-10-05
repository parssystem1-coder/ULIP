# Deployment Architecture

## Development

```text
Next.js / Web
NestJS / API
Worker
PostgreSQL
Redis
S3-compatible storage
```

## Production baseline

Use a reverse proxy/load balancer in front of stateless web/API processes. Workers scale independently from HTTP.

## Containers

A simple starting deployment can use containers for:

- web
- api
- worker
- postgres
- redis

Object storage may be managed or self-hosted depending on environment.

## Release process

1. Build immutable images.
2. Run unit/integration tests.
3. Apply compatible migrations.
4. Deploy web/API/workers.
5. Run smoke tests.
6. Verify health/readiness and queue depth.
7. Monitor error rate.

## Rollback

Application rollback and database rollback are not assumed to be symmetrical. Prefer backward-compatible migrations to minimize rollback risk.

## Phase 14: local runtime (implemented)

```bash
cd blueprint
# 1) infrastructure (postgres on host 5433 — 5432 may be taken by a native service):
docker compose -f infra/docker/docker-compose.runtime.yml up -d postgres redis
# 2) migrations (once, or via the migrator service):
ULIP_PG_URL=postgresql://postgres:postgres@localhost:5433/ulip \
  node --experimental-strip-types infra/scripts/migrate.ts
# 3) processes (see infra/env/smoke.env for the dev env):
set -a; source infra/env/smoke.env; set +a
pnpm dev:api      # http://localhost:3001  (/health, /ready)
pnpm dev:worker   # BullMQ consumer, DB is truth
pnpm dev:web      # http://localhost:3000
# 4) end-to-end proof:
node --experimental-strip-types infra/scripts/smoke.ts
```

Full container mode (`up --build`) builds api/worker/web images from
`Dockerfile.runtime` / `Dockerfile.web`; keep ~2 GB free on the Docker disk.
