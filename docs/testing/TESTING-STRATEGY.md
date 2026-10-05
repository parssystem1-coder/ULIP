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
