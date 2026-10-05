# ADR 023 — Typed Contracts; No `unknown` in Public Interfaces

## Status
Accepted (remediation 2026-10-04)

## Context
`blueprint/packages/*/src/*.ts` used `unknown` for core task input/output
(extract/decide/calculate), violating the project's own "typed DTOs" rule and
making contract testing impossible. Meanwhile the documentation defined rich
typed contracts that the code did not mirror.

## Decision
1. All public interfaces in domain/ai/connectors/scoring/orchestration packages
   are fully typed. `unknown` is banned from public contracts; exceptions are
   `Record<string, unknown>` payloads that model genuinely schema-less,
   untrusted source data (raw connector payloads, JSONB metadata).
2. The TypeScript interfaces mirror the documentation contracts:
   - AI task types ↔ `docs/ai/TASK-CONTRACTS.md`
   - Decision types ↔ ADR-017 probability contract
   - Orchestration tables ↔ `docs/architecture/ORCHESTRATION.md`
   - Search filters ↔ `docs/api/OPENAPI.yaml` LeadList parameters
3. Typechecking the packages is part of the build gate (ADR-025).

## Consequences
- Contract drift between docs and code is caught by review + tests, not by
  runtime surprises.
- Provider adapters must validate/parse into these types at the boundary.
