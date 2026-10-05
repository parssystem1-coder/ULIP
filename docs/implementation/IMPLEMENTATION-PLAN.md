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
