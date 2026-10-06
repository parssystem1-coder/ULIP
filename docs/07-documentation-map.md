# Documentation Map

## Start here

1. `README.md`
2. `docs/00-master-architecture-spec.md`
3. `docs/product/PRD.md`
4. `docs/architecture/TECHNICAL-ARCHITECTURE.md`
5. `docs/database/DATABASE.md`
6. `docs/api/API.md`
7. `docs/ai/AI.md`
8. `docs/connectors/CONNECTORS.md`
9. `docs/security/SECURITY.md`
10. `docs/implementation/IMPLEMENTATION-PLAN.md`
11. `prompts/master/MASTER-PROMPT.md`

## Implementation reference order

Product → Architecture → Database → API → AI → Connectors → Scoring/Evidence → Security/Operations → Phase prompt.

## Single source of truth rules

- Product behavior: PRD
- Architecture decisions: ADRs
- Data contracts: Database/API/AI contracts
- Implementation sequence: Implementation plan + phase prompts
- Code structure: Repository file tree + blueprint interfaces

When code differs from architecture, either update the architecture or create an ADR explaining why.

## Remediation additions (canonical)

- `docs/architecture/ORCHESTRATION.md` — Analysis Orchestrator, state machine, retry/failure
  policies (ADR-016)
- `docs/security/DATA-PROTECTION.md`, `docs/security/PII-DATA-MODEL.md`,
  `docs/security/RETENTION-POLICY.md` — data protection model (remediation §34)
- `database/migrations/` — authoritative evolution mechanism; `database/schema/schema.sql` is a
  readable snapshot
- `docs/api/OPENAPI.yaml` — authoritative API contract (ADR-020)
- `blueprint/packages/orchestration` — typed state-machine contracts
- `docs/adr/ADR-028-ai-analysis-scoring-runtime.md` +
  `prompts/phases/PHASE-16-AI-ANALYSIS-SCORING.md` — live AI analysis/scoring
  runtime (`@ulip/ai` provider selection, `@ulip/analysis` pipeline)
- `docs/adr/ADR-029-evaluation-calibration-regression.md` +
  `prompts/phases/PHASE-17-EVALUATION-CALIBRATION-REGRESSION.md` —
  evaluation framework (`@ulip/eval`, dataset, `pnpm eval` regression gate)
- `blueprint/packages/analysis` — evidence → classification → policy scoring →
  lead-state transition implementation (`buildEvidenceDrafts`,
  `computeDimensions`, `DbAnalysisStore`, `runAnalysisFlow`)
- `docs/ai/TASK-CONTRACTS.md` — prose mirror of the typed AI contracts,
  including the implemented provider-selection/validation contract
