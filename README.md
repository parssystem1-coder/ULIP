# Universal Lead Intelligence Platform (ULIP)

## Complete Product + Engineering Blueprint

**Version:** 1.1  
**Status:** Architecture / Implementation Blueprint  
**Primary initial source:** Instagram through a permitted/authorized connector  
**Product category:** Multi-source Lead Intelligence Platform  
**Architecture:** Provider-agnostic, AI-native, modular monolith, multi-tenant ready

---

## What this package contains

This package is deliberately larger than the original 17-file documentation bundle. It contains the full set of product, architecture, database, API, AI, connector, security, operations, testing and implementation documents required to begin a disciplined implementation.

The package contains:

- Product Requirements Document
- Master architecture specification
- Technical architecture
- Individual ADRs
- Complete logical ERD specification
- SQL schema blueprint
- Data dictionary
- Index and query strategy
- Seed/taxonomy model
- API contract
- OpenAPI starter contract
- AI architecture
- AI task and output contracts
- Jev decision-layer design
- Model evaluation and benchmarking design
- Connector framework contract
- Instagram connector boundary/specification
- Source compliance and access principles
- Taxonomy specification
- Scoring specification
- Evidence and explainability specification
- Security architecture and threat model
- Secrets/configuration policy
- Deployment architecture
- Observability and operations runbook
- Testing strategy and E2E scenarios
- Implementation plan
- Repository/file blueprint
- Master Claude Code prompt
- Individual implementation prompts for every planned phase
- Source-code interface blueprints and configuration skeletons

## Important distinction: blueprint vs implemented product

This archive is the **complete engineering blueprint and implementation starter package**. It does not falsely claim that external-platform integrations, production credentials, real provider SDKs, or a finished production application already exist.

The files under `blueprint/` are intentionally limited to architecture-safe interfaces and skeleton configuration. Claude Code is expected to implement the actual application incrementally according to the phase prompts and tests.

## Core principle

ULIP is not an Instagram scraper. Instagram is only the first connector. The core product consumes a universal lead contract so that additional sources can be added without rewriting the domain model.

```text
Source Connector
      ↓
Raw Source Data
      ↓
Normalization
      ↓
Identity Resolution
      ↓
Universal Lead
      ↓
AI Gateway
   ┌──┼────┬───────┐
   ↓  ↓    ↓       ↓
  LLM Vision Jev Embeddings
      ↓
Evidence + Validation
      ↓
Independent Scores
      ↓
Human Review
      ↓
Campaign / Export / CRM
```

## Safety and access boundary

Connectors must use only data the application is authorized/permitted to access. The architecture explicitly excludes CAPTCHA bypass, rate-limit evasion, cookie/session theft, credential abuse, anti-bot bypass, or unauthorized access mechanisms.

## Recommended implementation order

1. Repository audit
2. Foundation
3. Database and domain
4. Taxonomy
5. Connector framework
6. First permitted source connector
7. Raw data and normalization
8. Deduplication
9. AI gateway
10. Structured extraction
11. Evidence
12. Vision
13. Decision provider/Jev
14. Scoring
15. Audience quality
16. Human review and feedback
17. Search
18. Campaigns
19. Export
20. Observability
21. Testing
22. Security review
23. Performance
24. Documentation hardening

See `prompts/master/` for execution instructions.

## Buildable workspace (remediated)

`blueprint/` is a real pnpm workspace with a minimum validation gate:

```bash
cd blueprint
pnpm install
pnpm typecheck   # strict TS over all contract packages
pnpm test        # node:test suites (28 tests)
pnpm build       # typecheck + test
```

Database constraint tests (`database/tests/db-constraints.test.ts`) run when Postgres
is reachable — **verified 8/8 green on PostgreSQL 16 in Docker**; otherwise they
report `skipped` honestly instead of passing silently:

```bash
docker run -d --name ulip-pg-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ulip \n  -p 55432:5432 postgres:16
cd database && npm install
ULIP_PG_URL=postgresql://postgres:postgres@localhost:55432/ulip npm test
``` The roadmap is the canonical **13 phases
(00–12)** in `prompts/phases/` + `docs/implementation/IMPLEMENTATION-PLAN.md`.
See `docs/REMEDIATION-REPORT.md` for the full before/after of the architecture
remediation.

## Phase 15 — Real Discovery (implemented)

Discovery is live end-to-end: `POST /discovery/search` (Idempotency-Key
required) persists a DB-backed job, enqueues via BullMQ (transport only),
and the worker runs the real pipeline — source connector → immutable raw
snapshot → Persian-aware normalization → dedup/entity-resolution → lead at
`ANALYSIS_PENDING`. Connector resolution is honest by design
(`UNKNOWN_SOURCE_TYPE` / `NOT_CONFIGURED` / `UNSUPPORTED` / `RESOLVED`,
ADR-027): an authorized Instagram adapter is **not** configured, so Instagram
stays NOT_CONFIGURED/UNSUPPORTED; local E2E uses the deterministic fake
provider behind an explicit `allowFake: true` opt-in. No scraping, no
anti-bot bypass, ever. See `docs/adr/ADR-027-real-discovery-pipeline.md` and
`prompts/phases/PHASE-15-REAL-DISCOVERY.md`.

## Phase 16 — AI Analysis & Scoring Runtime (implemented)

Leads now complete the lifecycle through the real worker:
`ANALYSIS_PENDING → ANALYZING → AI analysis → evidence validation → scoring →
SCORED → QUALIFIED | REVIEW_REQUIRED | REJECTED`.

- **AI runtime** (`@ulip/ai`): provider-agnostic `selectAiRuntime()` with two
  honest states — `READY` or `NOT_CONFIGURED`. A configurable OpenAI-compatible
  HTTP LLM adapter (`AI_PROVIDER/AI_BASE_URL/AI_API_KEY/AI_MODEL/
  AI_TIMEOUT_MS/AI_MAX_RETRIES/AI_RETRY_BACKOFF_MS`) plus optional vision and
  embedding slots; no vendor is hard-coded. Production never selects the
  deterministic fake silently.
- **Deterministic fake provider** for tests/local E2E: predictable results for
  "HP printer parts wholesaler Tehran" and "Shiraz hair salon coloring
  balayage", in English and Persian, citing only evidence it actually matched.
- **Analysis runtime** (`@ulip/analysis`): evidence built from observed data
  (profile, bio, captions, location, engagement, contacts-presence) and
  persisted *before* the model call; universal business model (Business Type /
  Industry / Specialty / Sub-specialty / Brand / Location) mapped onto existing
  taxonomy nodes; evidence-first validation demotes unsupported claims.
- **Scoring**: the four independent dimensions plus policy-weighted priority,
  with weights/thresholds loaded from `scoring_policy_versions` (ACTIVE
  version; bootstrapped once per tenant) — never from application code.
- **Versioning & idempotency**: deterministic per-job analysis/score ids, one
  transaction per run, exactly one current analysis and score per lead,
  history superseded but never deleted.
- **API** (OpenAPI-synced): `GET /leads/{id}`, `GET /leads/{id}/analysis`,
  `GET /leads/{id}/evidence`, `GET /leads/{id}/scores`,
  `POST /leads/{id}/reprocess` — all tenant-scoped and authenticated.
- Jev remains unplugged; `DecisionProvider` stays optional (ADR-017).

See `docs/adr/ADR-028-ai-analysis-scoring-runtime.md` and
`prompts/phases/PHASE-16-AI-ANALYSIS-SCORING.md`.

### AI evaluation & regression (Phase 17)

Quality is measured, not assumed (ADR-029): `pnpm eval` runs the
`@ulip/eval` framework over a 34-case human-labeled dataset
(`packages/eval/dataset/eval-dataset-v1.json`) through the real evidence
pipeline, reports per-dimension accuracy/precision/recall/F1, calibration,
score diagnostics and a nine-category error taxonomy, and gates releases on
per-category regressions against committed baselines
(`packages/eval/baselines/`). Human corrections are append-only
(`evaluation_corrections`) and export into the next labeled dataset draft.
Live-provider evaluation is explicit (`ULIP_EVAL_LIVE=1`) — never in tests.

See `docs/adr/ADR-029-evaluation-calibration-regression.md` and
`prompts/phases/PHASE-17-EVALUATION-CALIBRATION-REGRESSION.md`.
