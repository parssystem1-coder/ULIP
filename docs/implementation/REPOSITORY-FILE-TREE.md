# Repository File Tree — Canonical (Remediated)

> **Canonical as of the architecture remediation.** Every entry is classified:
>
> - **[E]** existing (real file on disk today)
> - **[C]** to be created in its canonical phase (planned, does **not** exist yet)
> - **[O]** optional / future (explicitly deferred)
>
> Planned files are never claimed as implemented. `docs/archive/` is a frozen
> historical snapshot of conversation-v1 and is intentionally excluded from sync.

```text
ULIP/
├── README.md                                   [E] honest status: blueprint, not product
├── MANIFEST.md                                 [E]
├── FULL-FILE-INVENTORY.txt                     [E] generated inventory
├── LICENSE                                     [E] placeholder marked for owner decision (§35)
├── REMEDIATION-REPORT.md → docs/               [E] see docs/REMEDIATION-REPORT.md
│
├── database/
│   ├── schema/schema.sql                       [E] readable snapshot (migrations are authoritative)
│   ├── migrations/
│   │   ├── README.md                           [E] migration policy
│   │   └── 0001_initial_core/{up,down}.sql     [E] authoritative initial schema
│   ├── seeds/
│   │   ├── README.md                           [E] seed strategy
│   │   ├── 001_core_reference.sql              [E] roles, taxonomy, aliases, locations
│   │   └── 002_policies_example.sql            [E] example scoring/decision policies
│   └── tests/db-constraints.test.ts            [E] Docker-guarded constraint tests (§39)
│
├── blueprint/                                  [E] buildable pnpm workspace (ADR-025)
│   ├── package.json                            [E] typecheck/lint/test/build scripts
│   ├── pnpm-workspace.yaml                     [E]
│   ├── tsconfig.base.json / tsconfig.json      [E]
│   ├── pnpm-lock.yaml                          [E]
│   ├── apps/api/src/modules/README.md          [E] placeholder for the API app (Phase 01)
│   ├── infra/docker/docker-compose.yml         [E] Postgres+Redis for local dev/tests
│   └── packages/│       ├── domain/                             [E] contracts.ts, persian-normalize.ts + tests
│       ├── connectors/                         [E] typed connector contracts + capability tests (incl. ActionCapability)
│       ├── ai/                                 [E] typed AI/Jev contracts + validation tests
│       ├── scoring/                            [E] policy resolver + tests
│       ├── orchestration/                      [E] state machine transitions + tests
│       ├── social-actions/                     [E] ADR-026: action contracts/service/fakes + 17 tests
│       ├── outreach/                           [E] ADR-026: campaigns/templates/eligibility + 11 tests
│       └── api-contract/                       [E] OpenAPI validator (ADR-020) + house-rule tests
│
├── docs/
│   ├── 00-master-architecture-spec.md          [E] master spec (Business Type model)
│   ├── 07-documentation-map.md                 [E]
│   ├── README.md                               [E]
│   ├── adr/ADR-001 … ADR-025                   [E] incl. new 016–025 (remediation decisions)
│   ├── architecture/
│   │   ├── TECHNICAL-ARCHITECTURE.md           [E]
│   │   ├── AI-SYSTEM-ARCHITECTURE.md           [E]
│   │   ├── CONNECTOR-SYSTEM-ARCHITECTURE.md    [E]
│   │   ├── ORCHESTRATION.md                    [E] Analysis Orchestrator + state machine (ADR-016)
│   │   └── SCALING-AND-CAPACITY.md             [E]
│   ├── ai/ AI.md, TASK-CONTRACTS.md, TAXONOMY-ENGINE.md, SCORING-ENGINE.md,
│   │        EVIDENCE-AND-EXPLAINABILITY.md, MODEL-REGISTRY-AND-ROUTING.md,
│   │        EVALUATION-AND-BENCHMARKING.md    [E]
│   ├── api/ API.md, OPENAPI.yaml (authoritative), ERRORS-AND-PAGINATION.md [E]
│   ├── connectors/ CONNECTORS.md, GENERIC-CONNECTOR-CONTRACT.md,
│   │                 INSTAGRAM-CONNECTOR.md, ACCESS-AND-COMPLIANCE.md [E]
│   ├── database/ DATABASE.md, ERD.md, DATA-DICTIONARY.md,
│   │             INDEX-AND-QUERY-STRATEGY.md, MIGRATION-AND-VERSIONING.md [E]
│   ├── implementation/ IMPLEMENTATION-PLAN.md (canonical 13 phases),
│   │                   REPOSITORY-FILE-TREE.md, CODING-STANDARDS.md, RELEASE-CHECKLIST.md [E]
│   ├── operations/ DEPLOYMENT.md, OBSERVABILITY.md, RUNBOOK.md [E]
│   ├── product/ PRD.md, ROADMAP.md, ROLES-AND-PERMISSIONS.md, UX-SPEC.md [E]
│   ├── security/ SECURITY.md, THREAT-MODEL.md, SECRETS-AND-CONFIG.md,
│   │             ROLES.md, DATA-PROTECTION.md, PII-DATA-MODEL.md, RETENTION-POLICY.md [E]
│   ├── testing/ TESTING-STRATEGY.md, E2E-SCENARIOS.md [E]
│   ├── REMEDIATION-REPORT.md                   [E] remediation matrix + verification status
│   └── archive/conversation-v1/                [E] frozen historical snapshot (not synced)
│
└── prompts/
    ├── master/MASTER-PROMPT.md                 [E] references the canonical phases (incl. PHASE-13)
    └── phases/PHASE-00 … PHASE-13              [E] 14 phase prompts (13 canonical + Social Actions & Outreach)
```

## Files to be created later (canonical, not existing)

These are **[C]** items owned by their phases — listed so the tree stays honest:

```text
blueprint/apps/api/**            Phase 01+   NestJS application skeleton
blueprint/apps/worker/**         Phase 06+   BullMQ workers + orchestrator runtime
blueprint/packages/*/dist/**     build output (generated, gitignored)
docs/product/COMPETITORS.md      [O] optional future
```

## Removed during remediation

```text
database/seeds/001-taxonomy.sql   superseded by 001_core_reference.sql (old schema references)
```

## Phase 14 additions (runtime foundation — implemented)

```text
blueprint/
├── apps/
│   ├── api/                 [I] real HTTP API runtime (auth, tenants, repos, /health /ready)
│   ├── worker/              [I] real BullMQ worker (persistent-job claim, DISCOVERY flow)
│   └── web/                 [I] real Next.js shell (dashboard/leads/campaigns/sources/settings)
├── infra/
│   ├── docker/              [I] docker-compose.runtime.yml + Dockerfile.runtime + Dockerfile.web
│   ├── env/smoke.env        [I] dev smoke env template (placeholders only)
│   └── scripts/             [I] migrate.ts (ledger runner) + smoke.ts (E2E flow)
└── packages/
    └── runtime/             [I] env validation, logger, pg Database+migrations, auth hashing, JobQueue
```

Everything else keeps its previous marker (blueprint/skeleton/fake provider).

## Phase 15 additions (real discovery — implemented)

```text
blueprint/
├── packages/discovery/      [I] @ulip/discovery — connector registry (honest gates),
│                                Persian normalizer, DB raw store, DB entity resolver,
│                                real flow + deterministic fake provider + tests
└── apps/worker/test/        [I] connector registry tests (NOT_CONFIGURED/UNSUPPORTED gates)

docs/adr/ADR-027-real-discovery-pipeline.md    [I] pipeline + honesty boundaries
prompts/phases/PHASE-15-REAL-DISCOVERY.md      [I] phase spec
```

Discovery status change: worker DISCOVERY flow upgraded [skeleton→implemented];
`POST /discovery/search` + `GET /discovery/jobs/{id}` implemented per OPENAPI.

## Phase 16 additions (AI analysis & scoring runtime — implemented)

```text
blueprint/
├── packages/ai/src/           [I] @ulip/ai runtime added on top of the contracts:
│     config.ts                [I] AiConfigSchema / loadAiConfig / missingCredentials
│     errors.ts                [I] typed AiError hierarchy → orchestration ErrorCodes
│     http.ts                  [I] injectable JSON transport (timeout/retry/backoff)
│     http-llm.ts              [I] HttpLlmProvider (OpenAI-compatible, contract-repair)
│     http-providers.ts        [I] optional HttpVisionProvider / HttpEmbeddingProvider
│     fake.ts                  [I] DeterministicFakeLlmProvider (test/dev only)
│     factory.ts               [I] selectAiRuntime → READY | NOT_CONFIGURED
│     validation.ts            [I] validateExtractionOutput + enforceEvidenceFirst
│     test/                    [I] config, HTTP adapter, fake determinism,
│                               extraction validation + evidence-first demotion
├── packages/analysis/         [I] @ulip/analysis — the analysis runtime:
│     contracts.ts             [I] payload, store/policy/lifecycle ports, outcome
│     ids.ts                   [I] deterministic analysis/score/evidence ids (retry-safe)
│     evidence.ts              [I] evidence drafts from observed data (deterministic ids)
│     taxonomy.ts              [I] taxonomy mapping (id/label/alias, kind-checked)
│     dimensions.ts            [I] 4 score dimensions + structured reasons
│     policy.ts                [I] DbScoringPolicyResolver + default bootstrap
│     profile.ts               [I] universal model, classification drafts, summary
│     load-context.ts          [I] tenant-scoped lead context loader
│     store.ts                 [I] DbAnalysisStore (single transaction, current semantics)
│     complete.ts              [I] scoring → persist → SCORED → THRESHOLD_MAP
│     flow.ts                  [I] runAnalysisForLead + failure-policy mapping
│     test/fakes.ts            [I] in-memory store/policy/lifecycle doubles
│     test/                     [I] flow/dimensions/taxonomy/evidence tests
│     test/integration.analysis-db.test.ts  [I] real PostgreSQL coverage
├── packages/orchestration/src/db-orchestrator.ts  [I] implemented Orchestrator
├── apps/worker/src/main.ts    [I] ANALYSIS/REPROCESS flows + FAILURE_POLICY handling
└── apps/api/                  [I] lead/analysis/evidence/scores/reprocess endpoints
      test/integration.analysis.test.ts     [I] full-stack E2E

docs/adr/ADR-028-ai-analysis-scoring-runtime.md   [I] runtime decisions
prompts/phases/PHASE-16-AI-ANALYSIS-SCORING.md    [I] phase spec
docs/api/OPENAPI.yaml                              [I] /leads/{leadId}/analysis
```

Analysis status change: ANALYSIS/REPROCESS job types upgraded [stub→implemented];
`GET /leads/{id}(/analysis|/evidence|/scores)` + `POST /leads/{id}/reprocess`
implemented per OPENAPI.
