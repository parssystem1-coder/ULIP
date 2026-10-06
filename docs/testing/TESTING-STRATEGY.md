# Testing Strategy

## Test pyramid

### Unit
Pure domain rules and parsers.

### Integration
Database repositories, queue adapters, AI gateway adapters, connector contract adapters.

### Contract
Connector and API contract compliance.

### E2E
User-visible workflow from discovery to export.

## Critical unit suites

- taxonomy tree operations
- normalization
- identity matching
- score calculation
- threshold routing
- query parsing validation
- permission rules

## Critical integration suites

- raw entity persistence
- dedup constraints
- AI run tracking
- evidence persistence
- campaign bulk operations
- audit logging

## Determinism

Mock AI/provider responses in core tests. Use real provider tests as opt-in integration checks, not as the only basis for correctness.

## Social Actions & Outreach test matrix (ADR-026, PHASE-13)

Automated suites use ONLY fake providers (`FakeActionProvider`,
`FakeSocialActionPort`); real platform adapters are integration-tested
separately against authorized sandboxes.

| Area | Covered by |
| --- | --- |
| capability detection (honest report) | `@ulip/social-actions` — capabilityReport tests |
| follow/unfollow execution | social-actions — follow/unfollow tests |
| message eligibility | `@ulip/outreach` — eligibility rules test |
| bulk recipient handling (one message per lead) | outreach — bulk invariant tests |
| idempotency (replay + conflict) | social-actions — idempotency tests |
| suppression (always wins) | social-actions + outreach tests |
| action state transitions (declared edges only) | social-actions — transition table test |
| tenant isolation | social-actions + outreach isolation tests |
| provider failure/fallback + retry-after | social-actions — rate-limit/mid-flight tests |
| unsupported provider actions (NOT_SUPPORTED + manual plan) | social-actions — fallback tests |
| DB constraints (idempotency UNIQUE, suppression CHECK, down/up) | `database/tests/social-outreach-constraints.test.ts` (skip-honest without Postgres) |
| OpenAPI contract | `@ulip/api-contract` — structural + house rules + required paths |

## AI Analysis & Scoring test matrix (ADR-028, PHASE-16)

| Area | Covered by |
| --- | --- |
| provider configuration validation (fail-fast, honest NOT_CONFIGURED) | `@ulip/ai` — config tests |
| HTTP adapter retry/backoff/timeout + contract-repair path | `@ulip/ai` — http-llm tests (injected fetch, no network) |
| deterministic fake provider (EN/FA, both canonical examples) | `@ulip/ai` — fake-provider tests |
| AI request/response validation + evidence-first demotion | `@ulip/ai` — extraction-validation tests |
| taxonomy mapping (id/label/alias, kind safety, free-text fallback) | `@ulip/analysis` — taxonomy tests |
| five score dimensions + policy execution/version persistence | `@ulip/analysis` — dimensions tests |
| evidence determinism + PII minimization | `@ulip/analysis` — evidence tests |
| full flow, idempotency, versioning, failure policy | `@ulip/analysis` — flow tests |
| real PostgreSQL: persistence, current-record, tenant isolation, transitions | `@ulip/analysis` — integration.analysis-db tests (skip-honest without Postgres) |
| API endpoints + auth/tenant boundary + E2E through the real worker | `apps/api` — integration.analysis tests (opt-in: `ULIP_IT_WORKER=1`) |
| external AI provider | opt-in only, when real credentials are configured (never in CI default) |

## AI Evaluation test matrix (ADR-029, PHASE-17)

| Area | Covered by |
| --- | --- |
| dataset validation (human provenance, unique ids, canonical labels) | `@ulip/eval` — dataset tests (committed dataset re-validated on every run) |
| accuracy/precision/recall/F1, confusion matrix, abstention/coverage | `@ulip/eval` — metrics tests (hand-computable fixtures) |
| calibration buckets/ECE/over-confidence, score separation/correlation | `@ulip/eval` — metrics + runner tests |
| regression detection (direction-aware, CRITICAL/MAJOR/MINOR, version flag) | `@ulip/eval` — regression tests |
| error taxonomy (9 categories, TAXONOMY_MISMATCH refinement) | `@ulip/eval` — metrics tests |
| fake-provider evaluation + deterministic repeatability (same runId) | `@ulip/eval` — runner tests |
| mocked HTTP provider (injected fetch, no network) | `@ulip/eval` — runner tests |
| unavailable-provider handling (LLM + Jev arms NOT_CONFIGURED, never fabricated) | `@ulip/eval` — runner tests |
| version tracking (policy/prompt tuple → new runId) | `@ulip/eval` — runner tests |
| real PostgreSQL: run persistence, idempotent replay, append-only triggers, corrections uniqueness, tenant isolation, feedback export | `@ulip/eval` — integration.eval-db tests (skip-honest without `ULIP_PG_URL`) |
| live provider evaluation | CLI-only via `ULIP_EVAL_LIVE=1` + configured HTTP provider (never in tests/CI) |
