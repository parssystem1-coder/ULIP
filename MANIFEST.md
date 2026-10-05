# Package Manifest

This manifest is the authoritative inventory of the files included in the full ULIP blueprint archive.

## Product

- `docs/product/PRD.md`
- `docs/product/UX-SPEC.md`
- `docs/product/ROLES-AND-PERMISSIONS.md`
- `docs/product/ROADMAP.md`

## Architecture

- `docs/00-master-architecture-spec.md`
- `docs/architecture/TECHNICAL-ARCHITECTURE.md`
- `docs/architecture/AI-SYSTEM-ARCHITECTURE.md`
- `docs/architecture/CONNECTOR-SYSTEM-ARCHITECTURE.md`
- `docs/architecture/SCALING-AND-CAPACITY.md`

## ADRs

- `docs/adr/ADR-001-modular-monolith.md`
- `docs/adr/ADR-002-postgresql.md`
- `docs/adr/ADR-003-redis-bullmq.md`
- `docs/adr/ADR-004-provider-abstraction.md`
- `docs/adr/ADR-005-connector-architecture.md`
- `docs/adr/ADR-006-ai-gateway.md`
- `docs/adr/ADR-007-llm-jev-separation.md`
- `docs/adr/ADR-008-evidence-first.md`
- `docs/adr/ADR-009-human-in-the-loop.md`
- `docs/adr/ADR-010-scoring-separation.md`
- `docs/adr/ADR-011-dynamic-taxonomy.md`
- `docs/adr/ADR-012-raw-data-preservation.md`
- `docs/adr/ADR-013-no-automatic-outreach.md`
- `docs/adr/ADR-014-no-gnn-in-mvp.md`
- `docs/adr/ADR-015-parse-later.md`

## Database

- `docs/database/DATABASE.md`
- `docs/database/ERD.md`
- `docs/database/DATA-DICTIONARY.md`
- `docs/database/INDEX-AND-QUERY-STRATEGY.md`
- `docs/database/MIGRATION-AND-VERSIONING.md`
- `database/schema/schema.sql`
- `database/seeds/001-taxonomy.sql`

## API

- `docs/api/API.md`
- `docs/api/OPENAPI.yaml`
- `docs/api/ERRORS-AND-PAGINATION.md`

## AI

- `docs/ai/AI.md`
- `docs/ai/TASK-CONTRACTS.md`
- `docs/ai/MODEL-REGISTRY-AND-ROUTING.md`
- `docs/ai/EVALUATION-AND-BENCHMARKING.md`

## Connectors

- `docs/connectors/CONNECTORS.md`
- `docs/connectors/GENERIC-CONNECTOR-CONTRACT.md`
- `docs/connectors/INSTAGRAM-CONNECTOR.md`
- `docs/connectors/ACCESS-AND-COMPLIANCE.md`

## Intelligence

- `docs/ai/TAXONOMY-ENGINE.md`
- `docs/ai/SCORING-ENGINE.md`
- `docs/ai/EVIDENCE-AND-EXPLAINABILITY.md`

## Security / Operations / Testing

- `docs/security/SECURITY.md`
- `docs/security/THREAT-MODEL.md`
- `docs/security/SECRETS-AND-CONFIG.md`
- `docs/operations/DEPLOYMENT.md`
- `docs/operations/OBSERVABILITY.md`
- `docs/operations/RUNBOOK.md`
- `docs/testing/TESTING-STRATEGY.md`
- `docs/testing/E2E-SCENARIOS.md`

## Implementation

- `docs/implementation/IMPLEMENTATION-PLAN.md`
- `docs/implementation/REPOSITORY-FILE-TREE.md`
- `docs/implementation/CODING-STANDARDS.md`
- `docs/07-documentation-map.md`

## Claude Code prompts

- `prompts/master/MASTER-PROMPT.md`
- `prompts/phases/PHASE-00-REPOSITORY-AUDIT.md`
- `prompts/phases/PHASE-01-FOUNDATION.md`
- `prompts/phases/PHASE-02-DOMAIN-DATABASE.md`
- `prompts/phases/PHASE-03-TAXONOMY.md`
- `prompts/phases/PHASE-04-CONNECTOR-FRAMEWORK.md`
- `prompts/phases/PHASE-05-FIRST-CONNECTOR.md`
- `prompts/phases/PHASE-06-RAW-NORMALIZATION-DEDUP.md`
- `prompts/phases/PHASE-07-AI-GATEWAY-EXTRACTION.md`
- `prompts/phases/PHASE-08-VISION-JEV-EVIDENCE.md`
- `prompts/phases/PHASE-09-SCORING-AUDIENCE-QUALITY.md`
- `prompts/phases/PHASE-10-REVIEW-FEEDBACK-CAMPAIGNS-EXPORT.md`
- `prompts/phases/PHASE-11-OBSERVABILITY-TESTING-SECURITY.md`
- `prompts/phases/PHASE-12-HARDENING-DOCUMENTATION.md`

## Blueprint source files

- `blueprint/apps/api/src/modules/` — module boundary map
- `blueprint/apps/web/src/features/` — UI feature boundary map
- `blueprint/packages/*/src/` — interface contracts
- `blueprint/config/.env.example`
- `blueprint/infra/docker/docker-compose.yml`
- `blueprint/tsconfig.base.json`
- `blueprint/package.json`

## Remediation additions

- `database/migrations/0001_initial_core/{up,down}.sql`, `database/migrations/README.md`
- `database/seeds/001_core_reference.sql`, `database/seeds/002_policies_example.sql`, `database/seeds/README.md`
  (supersedes the removed `database/seeds/001-taxonomy.sql`)
- `database/tests/db-constraints.test.ts`
- `blueprint/pnpm-workspace.yaml`, `blueprint/tsconfig.json`, per-package `package.json`/`tsconfig.json`
- `blueprint/packages/{domain,connectors,ai,scoring,orchestration}/src/*` + tests
- `docs/architecture/ORCHESTRATION.md`
- `docs/adr/ADR-016 … ADR-025`
- `docs/security/DATA-PROTECTION.md`, `docs/security/PII-DATA-MODEL.md`, `docs/security/RETENTION-POLICY.md`
- `docs/REMEDIATION-REPORT.md`
