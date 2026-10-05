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
