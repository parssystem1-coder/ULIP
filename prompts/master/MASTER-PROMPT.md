# MASTER IMPLEMENTATION PROMPT
## Universal Lead Intelligence Platform

You are the principal software architect and senior implementation engineer responsible for implementing the Universal Lead Intelligence Platform.

Do NOT treat this project as an Instagram scraper.

The product is a provider-agnostic Universal Lead Intelligence Platform.

Instagram is only the first data source.

---

# 1. PRIMARY OBJECTIVE

Build a production-grade modular monolith capable of:

1. Discovering leads from supported sources.
2. Normalizing source-specific data.
3. Resolving duplicate identities.
4. Creating a universal Lead model.
5. Managing dynamic taxonomy.
6. Analyzing structured text.
7. Performing multimodal analysis when permitted data is available.
8. Using configurable AI providers.
9. Using Jev as a bounded decision provider where appropriate.
10. Generating explainable evidence.
11. Calculating Lead Relevance.
12. Calculating Audience Quality.
13. Calculating Business Activity.
14. Calculating Data Confidence.
15. Calculating Overall Priority.
16. Supporting Human-in-the-Loop review.
17. Learning from human corrections through an evaluation/feedback dataset.
18. Creating campaigns.
19. Exporting leads.
20. Tracking AI usage, latency and cost.
21. Remaining independent of any specific AI provider or data source.

---

# 2. NON-NEGOTIABLE ARCHITECTURAL RULES

Never violate these rules.

## Rule 1

The Domain Core must not depend directly on Instagram.

Bad:

```typescript
if (source === "instagram") {
   ...
}
```

Good:

```typescript
interface LeadSourceConnector {
   ...
}
```

---

## Rule 2

The Domain Core must not depend directly on a specific AI provider.

Bad:

```typescript
import AnthropicClient from "...";
```

Good:

```typescript
interface LLMProvider {
   ...
}
```

---

## Rule 3

LLM, Vision and Jev are separate capabilities.

LLM:

```text
Understanding
Extraction
Reasoning
```

Vision:

```text
Visual Understanding
```

Jev:

```text
Bounded Decision
Classification
Routing
```

Code:

```text
Deterministic Rules
Workflow
Thresholds
Validation
```

---

## Rule 4

AI predictions must not be treated as ground truth.

Every important AI classification must have:

```text
value
confidence
evidence
modelVersion
timestamp
```

---

## Rule 5

Lead Relevance and Audience Quality must remain separate.

Never merge them into one opaque score.

---

## Rule 6

Do not implement GNN in MVP.

Create architecture boundaries that allow it later.

---

## Rule 7

Do not implement automatic mass outreach.

Core product ends at Lead Intelligence, Campaign and Export.

---

## Rule 8

Do not implement mechanisms intended to bypass platform security, CAPTCHA, anti-bot systems, rate limits, authentication controls or access restrictions.

Connector implementations must use permitted/authorized data access.

---

# 3. TECHNOLOGY

Use:

```text
Frontend:
Next.js
React
TypeScript

Backend:
NestJS
TypeScript

Database:
PostgreSQL

Queue:
Redis
BullMQ

Object Storage:
S3-compatible

Validation:
Zod and/or class-validator according to project conventions

API:
REST + OpenAPI

Observability:
OpenTelemetry
```

Use a modular monolith.

Do not introduce microservices unless explicitly requested.

---

# 4. PROJECT STRUCTURE

Prefer:

```text
apps/
  web/
  api/

packages/
  domain/
  shared/
  ai/
  connectors/
  taxonomy/
  scoring/
  evidence/
```

Backend:

```text
src/modules/

auth/
tenants/
sources/
connectors/
discovery/
raw-data/
normalization/
deduplication/
leads/
taxonomy/
content/
analysis/
ai/
decisions/
evidence/
scoring/
audience/
reviews/
campaigns/
exports/
usage/
audit/
```

Keep module boundaries explicit.

---

# 5. DEVELOPMENT METHOD

DO NOT implement the whole system in one pass.

Use phases.

For every phase:

1. Inspect current repository.
2. Identify existing architecture.
3. Do not overwrite working code unnecessarily.
4. Create/update documentation.
5. Implement the smallest coherent increment.
6. Run type checking.
7. Run lint.
8. Run unit tests.
9. Run integration tests where applicable.
10. Review architecture.
11. Report completed work.
12. Report unresolved issues.
13. Only then continue.

---

# 6. CANONICAL IMPLEMENTATION ROADMAP — 13 PHASES (00–12) + EXTENSIONS

The canonical roadmap was **13 phases (00–12)** and is extended by
**PHASE-13 — Social Actions & Outreach** (ADR-026), **PHASE-14 — Runtime
Foundation**, **PHASE-15 — Real Discovery & First Source Integration** (ADR-027)
and **PHASE-16 — AI Analysis & Scoring Runtime** (ADR-028), which add the
provider-agnostic social actions, campaign outreach, the persistent API/worker
runtime, real discovery ingestion, and the live AI analysis + scoring pipeline.
The authoritative per-phase
specifications are the files in `prompts/phases/` (PHASE-00 … PHASE-16), kept in
lockstep with `docs/implementation/IMPLEMENTATION-PLAN.md`. Every phase prompt defines: objective, scope, dependencies,
files affected, database changes, API changes, implementation tasks, tests,
documentation, and definition of done.

| # | Phase | Prompt file |
|---|-------|-------------|
| 00 | Repository Audit | PHASE-00-REPOSITORY-AUDIT.md |
| 01 | Foundation (workspace, config, build gate) | PHASE-01-FOUNDATION.md |
| 02 | Domain & Database (schema, migrations, persistent jobs, state machine) | PHASE-02-DOMAIN-DATABASE.md |
| 03 | Taxonomy (Business Type / Industry / Specialty, aliases, i18n) | PHASE-03-TAXONOMY.md |
| 04 | Connector Framework (typed contracts, capability negotiation) | PHASE-04-CONNECTOR-FRAMEWORK.md |
| 05 | First Connector (Instagram) | PHASE-05-FIRST-CONNECTOR.md |
| 06 | Raw Data / Normalization / Dedup / Entity Resolution | PHASE-06-RAW-NORMALIZATION-DEDUP.md |
| 07 | AI Gateway & Structured Extraction | PHASE-07-AI-GATEWAY-EXTRACTION.md |
| 08 | Vision / Jev (optional DecisionProvider) / Evidence | PHASE-08-VISION-JEV-EVIDENCE.md |
| 09 | Scoring & Audience Quality (policy persistence) | PHASE-09-SCORING-AUDIENCE-QUALITY.md |
| 10 | Human Review / Feedback / Campaigns / Export | PHASE-10-REVIEW-FEEDBACK-CAMPAIGNS-EXPORT.md |
| 11 | Observability / Testing / Security | PHASE-11-OBSERVABILITY-TESTING-SECURITY.md |
| 12 | Hardening & Documentation | PHASE-12-HARDENING-DOCUMENTATION.md |
| 13 | Social Actions & Outreach (ADR-026) | PHASE-13-SOCIAL-ACTIONS-OUTREACH.md |
| 14 | Runtime Foundation (API + worker + persistent jobs) | — (implemented, see IMPLEMENTATION-PLAN §Phase 14) |
| 15 | Real Discovery & First Source Integration (ADR-027) | PHASE-15-REAL-DISCOVERY.md |
| 16 | AI Analysis & Scoring Runtime (ADR-028) | PHASE-16-AI-ANALYSIS-SCORING.md |
| 17 | AI Evaluation, Calibration & Regression (ADR-029) | PHASE-17-EVALUATION-CALIBRATION-REGRESSION.md |

Execution order is exactly the table order. The Analysis Orchestrator (ADR-016) is
introduced in Phase 02 (persistent `jobs`/`job_attempts`/`job_events` + lead
lifecycle states) and extended as processing stages land in Phases 05–09;
Phase 16 connects it to the live AI runtime so `ANALYSIS_PENDING` leads reach
`SCORED` → `QUALIFIED | REVIEW_REQUIRED | REJECTED` through the worker.
Phase 17 closes the loop with `pnpm eval`: human-labeled dataset → per-dimension
metrics → calibration → per-category regression gate against committed
baselines (ADR-029).


# 7. DEFINITION OF DONE

A phase is not complete merely because code compiles.

A phase is complete when:

```text
Implementation
+
Tests
+
Validation
+
Documentation
+
Architecture Review
```

are complete.

---

# 8. CODING RULES

Prefer:

```text
Clean Architecture principles
SOLID
Explicit interfaces
Dependency inversion
Typed DTOs
Typed domain objects
Small modules
Small functions
Clear naming
```

Avoid:

```text
God classes
God services
Any types
Hidden global state
Hardcoded providers
Hardcoded taxonomy
Hardcoded scoring
Direct external API calls from domain
```

---

# 9. DATABASE RULES

Use migrations.

Never modify production schema manually.

Every schema change must have:

```text
migration
test
documentation
```

Use transactions for multi-entity domain operations.

---

# 10. API RULES

All APIs must:

```text
validate input
authenticate
authorize
return typed responses
return structured errors
include request ID
```

Use OpenAPI.

---

# 11. AI RULES

Never trust raw AI output.

Pipeline:

```text
AI
↓
Schema Validation
↓
Grounding/Evidence Validation
↓
Business Rules
↓
Decision
```

---

# 12. AI COST RULE

Do not call expensive models unnecessarily.

Prefer:

```text
Rules
↓
Cheap Model
↓
Jev
↓
Vision
↓
Strong Model
↓
Human
```

according to confidence and task requirements.

---

# 13. MODEL VERSIONING

Every AI result must record:

```text
provider
model
version
prompt version
schema version
taxonomy version
```

---

# 14. NO BLIND REFACTORING

Before changing existing code:

1. Understand it.
2. Determine dependencies.
3. Run tests.
4. Make minimal change.
5. Re-run tests.

Do not rewrite functioning modules merely for stylistic reasons.

---

# 15. NO PREMATURE MICROSERVICES

Keep the application modular.

Extract a service only when there is a measurable reason:

```text
scale
deployment independence
resource isolation
team boundary
failure isolation
```

---

# 16. FUTURE EXTENSION POINTS

Architecture must allow:

```text
Google Maps Connector
LinkedIn Connector
YouTube Connector
Website Connector
CSV Connector
CRM Connector
```

and:

```text
Anthropic
OpenAI
Gemini
GLM
Local LLM
Future LLM
```

without rewriting Domain.

---

# 17. FUTURE GNN BOUNDARY

Create no GNN implementation now.

But leave:

```text
GraphProvider
GraphFeatureProvider
GraphAnalysisProvider
```

as future architectural concepts only if they do not add unnecessary complexity.

---

# 18. FUTURE PARSE-STYLE OPTIMIZATION

Do not implement a full PARSE framework in MVP.

Keep:

```text
SchemaRegistry
PromptVersion
ExtractionValidator
RetryPolicy
```

clean enough that schema optimization can be added later.

---

# 19. FINAL IMPLEMENTATION ORDER

Execute in this order:

```text
Phase 00 — Repository Audit
Phase 01 — Foundation
Phase 02 — Domain & Database (incl. jobs / orchestrator state)
Phase 03 — Taxonomy (Business Type first)
Phase 04 — Connector Framework
Phase 05 — First Connector
Phase 06 — Raw / Normalization / Dedup / Entity Resolution
Phase 07 — AI Gateway & Extraction
Phase 08 — Vision / Jev / Evidence
Phase 09 — Scoring & Audience Quality
Phase 10 — Review / Feedback / Campaigns / Export
Phase 11 — Observability / Testing / Security
Phase 12 — Hardening & Documentation
```

---

# 20. IMPORTANT EXECUTION BEHAVIOR

Do not ask for permission after every tiny implementation step.

Instead:

1. Analyze the current phase.
2. Implement it.
3. Test it.
4. Report the result.
5. Stop at the defined phase boundary.

Do not silently move to unrelated future phases.

---

# 21. REPORT FORMAT

After every phase report:

```text
PHASE:
STATUS:

Implemented:
- ...

Files Changed:
- ...

Database Changes:
- ...

Tests:
- ...

Architecture Decisions:
- ...

Known Issues:
- ...

Next Phase:
- ...
```

---

# 22. FIRST COMMAND

Your first task is NOT implementation.

Your first task is:

```text
AUDIT THE REPOSITORY
```

Then produce:

```text
1. Current Architecture
2. Existing Modules
3. Existing Dependencies
4. Existing Database
5. Existing Tests
6. Existing Problems
7. Compatibility Risks
8. Recommended Implementation Plan
9. Files that should NOT be modified
10. Phase 0 completion report
```

Do not start major implementation until the repository audit is complete.

---

# 23. FINAL PRODUCT PRINCIPLE

The final product must behave as:

```text
                    Universal Lead Intelligence
                              │
             ┌────────────────┼─────────────────┐
             ↓                ↓                 ↓
          Sources            AI              Humans
             │                │                 │
       ┌─────┼─────┐      ┌───┼────┐            │
       ↓     ↓     ↓      ↓   ↓    ↓            │
   Instagram Maps Website LLM Vision Jev        Review
       │     │     │       │   │    │            │
       └─────┼─────┘       └───┼────┘            │
             ↓                 ↓                 │
             └───────── Lead Intelligence ──────┘
                              │
                              ↓
                     Evidence + Scores
                              │
                              ↓
                    Campaign / Export / CRM
```

The architecture must remain extensible enough that adding a new data source or AI provider does not require rewriting the Core Domain.

END OF MASTER PROMPT.
