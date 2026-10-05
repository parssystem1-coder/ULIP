# Proposed Repository / File Tree
## Universal Lead Intelligence Platform

This is the implementation blueprint derived from the architecture and Master Prompt. It is a planned structure, not an already-implemented source tree.

```text
universal-lead-intelligence/
├── README.md
├── LICENSE
├── .gitignore
├── .env.example
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
│
├── apps/
│   ├── web/
│   │   ├── package.json
│   │   ├── next.config.*
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (dashboard)/
│   │   │   │   ├── leads/
│   │   │   │   ├── discovery/
│   │   │   │   ├── campaigns/
│   │   │   │   ├── taxonomy/
│   │   │   │   ├── reviews/
│   │   │   │   ├── settings/
│   │   │   │   └── api/
│   │   │   ├── components/
│   │   │   ├── features/
│   │   │   ├── lib/
│   │   │   ├── hooks/
│   │   │   ├── state/
│   │   │   └── types/
│   │   └── tests/
│   │
│   └── api/
│       ├── package.json
│       ├── tsconfig.json
│       ├── nest-cli.json
│       ├── src/
│       │   ├── main.ts
│       │   ├── app.module.ts
│       │   ├── common/
│       │   │   ├── auth/
│       │   │   ├── errors/
│       │   │   ├── logging/
│       │   │   ├── request-context/
│       │   │   ├── validation/
│       │   │   └── http/
│       │   │
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   │   ├── application/
│       │   │   │   ├── domain/
│       │   │   │   ├── infrastructure/
│       │   │   │   └── presentation/
│       │   │   ├── tenants/
│       │   │   ├── users/
│       │   │   ├── sources/
│       │   │   ├── connectors/
│       │   │   ├── discovery/
│       │   │   ├── raw-data/
│       │   │   ├── normalization/
│       │   │   ├── deduplication/
│       │   │   ├── leads/
│       │   │   ├── taxonomy/
│       │   │   ├── content/
│       │   │   ├── analysis/
│       │   │   ├── ai/
│       │   │   ├── decisions/
│       │   │   ├── evidence/
│       │   │   ├── scoring/
│       │   │   ├── audience/
│       │   │   ├── reviews/
│       │   │   ├── campaigns/
│       │   │   ├── exports/
│       │   │   ├── usage/
│       │   │   └── audit/
│       │   │
│       │   └── infrastructure/
│       │       ├── database/
│       │       ├── queue/
│       │       ├── storage/
│       │       └── observability/
│       └── test/
│
├── packages/
│   ├── domain/
│   │   ├── package.json
│   │   └── src/
│   │       ├── lead/
│   │       ├── business/
│   │       ├── taxonomy/
│   │       ├── scoring/
│   │       ├── evidence/
│   │       ├── decisions/
│   │       └── shared/
│   │
│   ├── shared/
│   │   └── src/
│   │       ├── types/
│   │       ├── constants/
│   │       ├── schemas/
│   │       └── utils/
│   │
│   ├── ai/
│   │   └── src/
│   │       ├── interfaces/
│   │       ├── gateway/
│   │       ├── registry/
│   │       ├── routing/
│   │       ├── usage/
│   │       └── providers/
│   │           ├── llm/
│   │           ├── vision/
│   │           ├── decision/
│   │           └── embedding/
│   │
│   ├── connectors/
│   │   └── src/
│   │       ├── core/
│   │       ├── registry/
│   │       └── providers/
│   │           ├── instagram/
│   │           ├── google-maps/
│   │           ├── linkedin/
│   │           ├── youtube/
│   │           ├── facebook/
│   │           ├── website/
│   │           └── csv/
│   │
│   ├── taxonomy/
│   ├── scoring/
│   ├── evidence/
│   └── config/
│
├── database/
│   ├── migrations/
│   ├── seeds/
│   ├── schema/
│   └── README.md
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── API.md
│   ├── AI.md
│   ├── CONNECTORS.md
│   ├── TAXONOMY.md
│   ├── SCORING.md
│   ├── SECURITY.md
│   ├── OBSERVABILITY.md
│   └── ADR/
│       ├── ADR-001-modular-monolith.md
│       ├── ADR-002-postgresql.md
│       ├── ADR-003-redis-bullmq.md
│       ├── ADR-004-provider-abstraction.md
│       ├── ADR-005-connector-architecture.md
│       ├── ADR-006-ai-gateway.md
│       ├── ADR-007-llm-jev-separation.md
│       ├── ADR-008-evidence-first.md
│       ├── ADR-009-human-in-the-loop.md
│       ├── ADR-010-scoring-separation.md
│       ├── ADR-011-dynamic-taxonomy.md
│       ├── ADR-012-raw-data-preservation.md
│       ├── ADR-013-no-automatic-outreach.md
│       ├── ADR-014-no-gnn-in-mvp.md
│       └── ADR-015-parse-later.md
│
├── prompts/
│   ├── master-claude-code.md
│   ├── phase-00-repository-audit.md
│   ├── phase-01-foundation.md
│   ├── phase-02-domain.md
│   ├── phase-03-taxonomy.md
│   ├── phase-04-sources.md
│   ├── phase-05-first-connector.md
│   ├── phase-06-raw-data.md
│   ├── phase-07-normalization.md
│   ├── phase-08-deduplication.md
│   ├── phase-09-ai-gateway.md
│   ├── phase-10-extraction.md
│   ├── phase-11-evidence.md
│   ├── phase-12-vision.md
│   ├── phase-13-decision-provider.md
│   ├── phase-14-scoring.md
│   ├── phase-15-audience-quality.md
│   ├── phase-16-human-review.md
│   ├── phase-17-feedback.md
│   ├── phase-18-campaigns.md
│   ├── phase-19-search.md
│   ├── phase-20-natural-language-search.md
│   ├── phase-21-export.md
│   ├── phase-22-observability.md
│   ├── phase-23-testing.md
│   ├── phase-24-security.md
│   ├── phase-25-performance.md
│   └── phase-26-documentation.md
│
├── scripts/
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
│
└── infra/
    ├── docker/
    ├── observability/
    └── deployment/
```

## Module boundary principles

### Domain

Contains business concepts and rules. Must not import external provider SDKs.

### Connectors

Contain platform-specific access and transformation logic. They implement source interfaces and return normalized/raw contracts.

### AI

Contains provider adapters, routing, usage tracking and AI contracts. Domain uses interfaces, not vendor SDKs.

### Evidence

Stores and links the evidence supporting predictions and decisions.

### Scoring

Contains independently testable scoring engines and configurable weighting.

### Presentation

REST/OpenAPI endpoints and DTOs live here; controllers must not contain domain logic.

## Implementation note

This tree is intentionally broader than the current MVP because it reserves clean extension points. Phase execution should create only the folders/files necessary for the current phase, while preserving these boundaries.
