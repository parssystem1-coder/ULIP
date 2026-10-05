# ADR 020 — OpenAPI as the Authoritative API Contract

## Status
Accepted (remediation 2026-10-04)

## Context
API.md and OPENAPI.yaml had drifted: the YAML was skeletal
(`additionalProperties: true` for core entities), lacked error schemas,
idempotency, and several documented endpoint groups. Contract testing was
declared but impossible.

## Decision
1. `docs/api/OPENAPI.yaml` is the single authoritative API contract.
2. `docs/api/API.md` is narrative documentation and must link to the YAML;
   when they disagree, the YAML wins and API.md is corrected.
3. Core entities have explicit component schemas (no
   `additionalProperties: true` for Lead/Business/Job/etc.).
4. Errors use the reusable ApiError family; repeatable POSTs declare
   Idempotency-Key semantics in parameters + description.
5. Generated DTOs (server + client) derive from this file in Phase 1; the YAML
   is validated in CI (parse + lint).

## Consequences
- API surface changes require a YAML change first (contract-first).
- API.md edits that contradict the YAML are rejected in review.
