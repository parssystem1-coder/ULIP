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

## Phase 15 — Real Discovery & First Source Integration (implemented)

Discovery is no longer a stub. The production path runs the real pipeline:

```text
Discovery Request → Source Connector → RawEntity → raw snapshot persistence
→ Normalization (Persian-aware, deterministic) → Deduplication / Entity
Resolution (identity keys) → Lead creation/update → ANALYSIS_PENDING
```

- **packages/discovery** (`@ulip/discovery`) — the pipeline core:
  `ConnectorRegistry` (honest resolution: UNKNOWN_SOURCE_TYPE /
  NOT_CONFIGURED / UNSUPPORTED / RESOLVED), `PersianAwareNormalizer`
  (ADR-019 alias keys + business-model hints), `DbRawEntityStore`
  (immutable raw_entities + currents pointer, content-hash dedup),
  `DbEntityResolver` (exact `lead_identities(source_id, external_id)` key;
  same-name inside a tenant creates an entity_resolution_candidates row for
  review instead of a silent merge), canonical LEAD_TRANSITION_TABLE events
  applied conditionally (deterministic, idempotent).
- **First source integration** — the production boundary is
  `ConfiguredHttpApiConnectorFactory` (INSTAGRAM / HTTP_API): validates
  tenant-supplied authorized-API credentials (provider + https base URL +
  token) at config time with NO network. It advertises NO discovery
  capability until a real authorized adapter is implemented — configured
  discovery over it fails with UNSUPPORTED, never a silent fake. No scraping,
  no CAPTCHA/anti-bot bypass, no session extraction (ADR-013/027).
- **Deterministic fake provider** — a real LeadSourceConnector over a fixed
  dataset for local E2E; refused by the registry unless explicitly allowed
  (`allowFake` on the request + `allowDeterministicFakes`).
- **API** — `POST /discovery/search` (OPENAPI.yaml as source of truth,
  Idempotency-Key required, replays return the original job; 409 on
  SOURCE_NOT_ACTIVE / IDEMPOTENCY_IN_FLIGHT; universal business-model filters
  businessType/industry/specialty/subSpecialty/brand/location) and
  `GET /discovery/jobs/{jobId}`.
- **Worker** — DISCOVERY jobs execute the real pipeline via the registry;
  DB stays the source of truth, BullMQ transport-only; failures map to
  BAD_REQUEST / NOT_CONFIGURED / WORKER_ERROR with job_events audit trail
  and request-id/correlation context end-to-end.
- **Verified** (real stack): discovery E2E with the fake provider green
  (API↔PG↔Redis↔Worker), raw rows + RULE classifications observable in
  PostgreSQL, repeats deduplicated (no new raw revisions, leads UPDATED not
  duplicated), tenant isolation + 401 + idempotency replay tested.
  Instagram status: configured-but-unimplemented boundary, NOT_CONFIGURED
  without credentials, UNSUPPORTED capability — honest, per ADR-027.

## Phase 17 — AI Evaluation, Calibration & Regression Framework (implemented)

The platform now measures classification/scoring quality instead of assuming
it (ADR-029): a 34-case human-labeled dataset (v1.0.0) frozen against the
seed taxonomy; the `@ulip/eval` runner executing RULES_ONLY / LLM_ONLY /
RULES_THEN_LLM through the real evidence pipeline (Jev arms honest
NOT_CONFIGURED); per-dimension accuracy/precision/recall/F1 + confusion
matrix, calibration (ECE, over-confidence), score diagnostics (separation,
zero-share, correlation), the nine-category error taxonomy; append-only
evaluation tables (0004) with human corrections and a feedback-dataset
export; `pnpm eval` comparing every run against committed baselines with a
CRITICAL/MAJOR regression release gate; read-side `/evaluation/*` API.
Live-provider evaluation is explicitly gated (`ULIP_EVAL_LIVE=1`).

## Phase 18 — Instagram Content Intelligence & Multimodal Analysis (implemented)

Content is now a first-class analysis input (ADR-030), not an optional string
attached to the bio:

- **Ingestion** — discovery parses connector payload `posts`/`media`/`contents`
  arrays (`DbContentIngestor`) into `lead_contents` with Instagram-style types
  (POST/REEL/CAROUSEL added to the CHECK), deterministic ids, sha256 content
  hash; idempotent, historical content never overwritten.
- **Sampling** — deterministic `RECENCY_DIVERSITY_SIGNAL` sampler (BASIC 3 /
  STANDARD 8 / DEEP 16) over recency → type diversity → high-signal →
  representative (repeated topics) → only-available, with per-item selection
  reasons and recorded skips.
- **Multimodal** — text analysis via the existing LLM extraction; Vision via the
  `AiRuntime` vision slot for a budget-capped selection of media items
  (BASIC 0 / STANDARD 2 / DEEP 4); unavailable/missing/failing modalities are
  recorded explicitly (`VISION_UNAVAILABLE`, `MODALITY_UNAVAILABLE`,
  `METADATA_ONLY`), never fabricated; video stays metadata-only.
- **Evidence aggregation** — every sampled item cites its `lead_contents/{id}`
  CAPTION_TEXT row; analyzed images cite IMAGE_OBSERVATION rows; keyword
  signals (BT_*/CI_*) carry per-item evidence ids, repeated independent hits
  raise confidence; content folds into confidence/activity/relevance without
  replacing the Phase 16 score architecture.
- **Consistency + review reasons** — profile-vs-content consistency
  (AGREE/PARTIAL/CONFLICT/INSUFFICIENT_CONTENT); conflicts demote confidence and
  force QUALIFIED → REVIEW_REQUIRED; structured review reasons
  (PROFILE_CONTENT_CONFLICT, INSUFFICIENT_CONTENT, WEAK_EVIDENCE,
  MODALITY_UNAVAILABLE, TAXONOMY_AMBIGUITY) persisted on content_analyses.
- **Persistence** — migration `0005_content_intelligence`:
  `content_analyses` (versioned, is_current/superseded_at, sampling JSONB,
  consistency, activity signals, relevance, review reasons) +
  `content_analysis_items` (per-item modalities/relevance/topics);
  deterministic ids → idempotent replay; evaluation_runs.arm widened with the
  four content arms.
- **API** — `GET /leads/{id}/contents`, `GET /leads/{id}/content-analysis`
  (+ `?history=1`), OpenAPI schemas synced.
- **Eval** — PROFILE_ONLY / TEXT_CONTENT / TEXT_IMAGE /
  FULL_AVAILABLE_EVIDENCE arms with committed baselines (fake vision provider
  `fake-vision.ts` for determinism; real vision honestly gated on
  AI_VISION_MODEL).

## Phase 16 — AI Analysis & Scoring Runtime (implemented)

The AI contracts are now connected to the real pipeline (ADR-028):

```text
ANALYSIS_PENDING → ANALYZING → evidence → AI extraction → validation
→ taxonomy mapping → policy scoring → SCORED → THRESHOLD_MAP
→ QUALIFIED | REVIEW_REQUIRED | REJECTED
```

- **packages/ai** (`@ulip/ai`) — runtime layer added on top of the existing
  contracts: `AiConfigSchema`/`loadAiConfig` (fail-fast validation, missing
  credentials → NOT_CONFIGURED), `selectAiRuntime()` (READY | NOT_CONFIGURED,
  fake refused in production), `HttpLlmProvider` (OpenAI-compatible Chat
  Completions with timeout, bounded retries, one contract-repair attempt,
  `response_format` sanitize-retry), optional `HttpVisionProvider` /
  `HttpEmbeddingProvider`, `DeterministicFakeLlmProvider`,
  `validateExtractionOutput` + `enforceEvidenceFirst` (evidence-first), typed
  `AiError` hierarchy mapped onto orchestration ErrorCodes.
- **packages/analysis** (`@ulip/analysis`, new) — `runAnalysisForLead` flow,
  `buildEvidenceDrafts` (observed data only, deterministic ids),
  `mapToTaxonomy` (id → label → alias, kind-checked, honest free-text
  fallback), `computeDimensions` (4 independent dimensions with reasons),
  `DbScoringPolicyResolver` (+ idempotent bootstrap of the documented default),
  `DbAnalysisStore` (one transaction: analysis + evidence link +
  classifications + current-version supersessions + scores + `ai_runs`),
  `loadLeadContext` (tenant-scoped inputs).
- **packages/orchestration** — implemented `DbOrchestrator` (the ONLY writer
  of `leads.status`): `startAnalysis`, `reprocess`, `resume`, `cancel`,
  conditional `applyLeadEvent` validated against `LEAD_TRANSITION_TABLE`.
- **apps/worker** — ANALYSIS/REPROCESS jobs run the real analysis flow;
  step progress (ANALYSIS → EVIDENCE_VALIDATION → SCORING) written to the job
  row; failure handling per `FAILURE_POLICY` (bounded retry re-arms the row to
  PENDING with `run_after` + delayed re-enqueue + `job_attempts` /
  `RETRY_SCHEDULED`, exhausted retries → lead FAILED, AI_UNAVAILABLE →
  REVIEW_REQUIRED, SKIPPED jobs recorded); idempotent replay via
  `ai_runs.job_id`.
- **apps/api** — `GET /leads/{id}`, `GET /leads/{id}/analysis`,
  `GET /leads/{id}/evidence`, `GET /leads/{id}/scores`,
  `POST /leads/{id}/reprocess` (optional Idempotency-Key replay, domain-level
  active-job reuse, 409 on illegal moves) — all authenticated and
  tenant-scoped; `AnalysisRepository` read side.
- **Verified** (real stack): PostgreSQL integration tests green (full run,
  duplicate-run idempotency, supersession, tenant isolation, orchestrator
  transitions), worker E2E green (discovery → reprocess → analysis → scores →
  terminal state → versioning → isolation/401), DB constraint suites 8/8 +
  5/5 on real PostgreSQL.
- Jev remains unplugged: no DecisionProvider is required for RULES_ONLY or
  LLM_ONLY execution.

## Phase 20 — Natural Language Search & Search Execution (implemented)

NL search is now wired end-to-end through a single engine (`@ulip/search`,
new) that both entry points share:

```text
text → parse (LLM | deterministic rules) → sanitize into LeadSearchFilters
     → tenant-scoped taxonomy resolution (id/slug/name/alias + location_aliases)
     → parameterized SQL execution → deterministic ranking with reasons
     → capability-aware discovery plan
```

- **Parsing** — reuses the existing `parseSearchQuery` contract (HTTP LLM when
  READY; `RULES_FALLBACK` deterministic Persian-first parser otherwise). LLM
  output is sanitized into typed filters only (never SQL, never raw
  expressions); locale is detected fa/en/mixed; empty/oversized text → 400.
- **Taxonomy resolution** — `DbTaxonomyResolver` resolves terms via
  taxonomy_nodes (id, slug, name), `taxonomy_node_aliases` (alias_norm) and
  `location_aliases` for cities; tenant-scoped; unresolved terms are reported
  AND all terms — resolved labels included — participate in content-aware
  free-text matching (Phase 20.1).
- **Execution** — `DbSearchExecutor`: parameterized SQL only (LIKE-escaped,
  NUL-stripped), unconditional tenant scoping, all nine match flags computed
  in SQL, page-based pagination with deterministic tiebreak, score-threshold
  filters (minRelevance/AudienceQuality/Activity/Confidence), and the Phase
  20.1 dual match path: structured taxonomy filters OR content-aware
  free-text over name/description/lead_contents, with hard constraints
  (tenant/city/status/scores/source) AND-ed for both paths and bounded
  snippets attached.
- **Ranking** — deterministic composite 0..100 (policy priority → relevance →
  neutral 50 baseline + fixed per-dimension boosts) with structured
  `reasons[]` per lead (no chain-of-thought).
- **Discovery planning** — `CapabilityDiscoveryPlanner` checks every ACTIVE
  source through the real ConnectorRegistry; honest per-source verdicts
  (SUPPORTED/PARTIAL/UNSUPPORTED with reasons); Instagram reports broad
  semantic/location discovery as unavailable (only hashtag/username discovery
  exists); `mode=DISCOVER_WHEN_SUPPORTED` executes the first SUPPORTED step
  (DB-persisted job first, BullMQ transport second; fake sources require the
  explicit `allowFake` opt-in, which is preserved verbatim into the persisted
  job payload so the worker executes exactly what the planner decided —
  Phase 20.1).
- **API** — `POST /leads/search/natural-language` (parser provenance always
  named) and upgraded `GET /leads` (same engine, full structured filters,
  page-based pagination). OpenAPI schemas added/synced.
- **UI** — minimal NL search surface on the leads page (Persian placeholder,
  parser provenance, ranked results with reasons, honest discovery plan).
- **Verified** (real PostgreSQL + Redis + API + worker): 19/19 API
  integration tests green — NL search shape + parser honesty, structured
  filtering, SQL-injection payloads, tenant isolation, discovery idempotency
  mismatch → 409, analysis E2E (fake AI), discovery E2E. `pnpm typecheck`,
  `pnpm lint`, `pnpm test` (261 tests), `pnpm build`, OpenAPI validation and
  `pnpm eval` (release gate PASS) all green.
