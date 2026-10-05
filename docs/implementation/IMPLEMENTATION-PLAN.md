# Implementation Plan

## Phase 00 — Repository audit

Inventory current code, architecture, dependencies, database, tests, deployment and conventions. Output a compatibility report before changing major code.

## Phase 01 — Foundation

Configuration, application boot, error handling, request context, auth boundary, tenant context, health/readiness, logging.

## Phase 02 — Domain/database

Create schema, repositories, domain entities and migrations.

## Phase 03 — Taxonomy

Dynamic hierarchy and APIs.

## Phase 04 — Connector framework

Interfaces, registry, capability negotiation, test kit.

## Phase 05 — First connector

Implement the first authorized/permitted source path without bypass behavior.

## Phase 06 — Ingest/normalize/dedup

Raw persistence, canonical mapping, identity resolution.

## Phase 07 — AI gateway/extraction

Provider registry, structured extraction, schema validation, AI usage.

## Phase 08 — Vision/Jev/evidence

Multimodal path, bounded decision provider, evidence model and validation.

## Phase 09 — Scoring/audience quality

Independent score engines and configurable routing thresholds.

## Phase 10 — Review/feedback/campaign/export

Human review, feedback dataset, campaign workflows and exports.

## Phase 11 — Observability/testing/security

Telemetry, E2E, security checks and operational readiness.

## Phase 13 — Social Actions & Outreach (ADR-026)

Provider-agnostic social actions (open/follow/unfollow/message) with honest
capability negotiation and manual fallback, plus campaign-based outreach with
message templates, per-lead eligibility, explicit human confirmation and bulk
execution as one separate message per lead. Persistent model in migration
`0002_social_actions_outreach`; API in OPENAPI.yaml (Social Actions / Outreach
tags). See `prompts/phases/PHASE-13-SOCIAL-ACTIONS-OUTREACH.md`.

## Phase 12 — Hardening/documentation

Performance review, documentation synchronization, migration notes, runbooks and release checklist.

## Gate rule

A phase is not complete when it merely compiles. It is complete when implementation, tests, documentation and review outputs exist.

## Phase 14 — Runtime Foundation (implemented)

The blueprint became a runnable system. Status markers: **implemented** below;
everything not listed remains blueprint/skeleton (see REPOSITORY-FILE-TREE).

- **packages/runtime** — env validation (zod, fail-fast), structured Logger,
  guarded pg `Database` + migration runner (`schema_migrations` ledger),
  scrypt/pbkdf2 auth hashing, shared BullMQ `JobQueue` transport.
- **apps/api** — real HTTP runtime (node:http, no framework): request-id,
  structured logging, api-key auth boundary, tenant context, global error
  shape, /health + /ready, repositories for tenant/user/source/taxonomy/lead/
  campaign/job, endpoints for sources, taxonomy, leads, campaigns, jobs
  (POST /jobs persists first, then enqueues to BullMQ; transport-only Redis).
- **apps/worker** — real BullMQ worker: exactly-once claim of the persistent
  job row (PENDING→RUNNING), DISCOVERY flow stub, writes SUCCEEDED/FAILED +
  job_events back to PostgreSQL. DB is truth; Redis is transport.
- **apps/web** — real Next.js app (build passes) with minimal shell:
  Dashboard / Leads / Campaigns / Sources / Settings.
- **Docker** — `infra/docker/docker-compose.runtime.yml` (postgres:16 on host
  5433 because a native postgres may occupy 5432, redis:7, migrator, api,
  worker, web) + Dockerfile.runtime / Dockerfile.web.
- **Verified on real infra** (this machine): migrations 0001–0003 applied to
  Dockerized PostgreSQL; DB constraint suites green (8/8 core + 5/5 social);
  smoke flow green end-to-end: health → bootstrap tenant → source → taxonomy
  → lead → campaign → persistent job → worker processed → API SUCCEEDED;
  API↔PG↔Redis↔Worker integration tests 5/5 green.
- Jev is NOT integrated: optional `DecisionProvider` contract unchanged.
