# PHASE 16 — AI ANALYSIS & SCORING RUNTIME

## Objective

Connect the existing `@ulip/ai` contracts to the real worker/orchestration
pipeline so leads in `ANALYSIS_PENDING` are processed through:

```text
ANALYSIS_PENDING → ANALYZING → AI Analysis → Evidence Validation → Scoring
  → SCORED → QUALIFIED | REVIEW_REQUIRED | REJECTED
```

Reuse (do not redesign): typed AI contracts, lead_analyses/evidence/
lead_scores/scoring policy tables, `LEAD_TRANSITION_TABLE`, the persistent Job
model, tenant/idempotency/audit conventions.

## Flow (canonical)

```text
POST /leads/{leadId}/reprocess   (optional Idempotency-Key)
→ DbOrchestrator.reprocess: REPROCESS edge → ANALYSIS_PENDING + REPROCESS job
→ BullMQ transport (job id only)
→ worker claims the job row (PENDING → RUNNING)
→ selectAiRuntime(env)          READY | NOT_CONFIGURED (checked BEFORE ANALYZING)
→ ANALYSIS_PENDING → ANALYZING  (canonical event ANALYSIS_STARTED)
→ evidence drafts built from observed data → persisted (idempotent ids)
→ LLMProvider.extractStructuredProfile(evidence samples + taxonomy snapshot)
→ contract validation + evidence-first enforcement (demote unsupported fields)
→ taxonomy mapping onto EXISTING nodes (id → label → alias, kind-checked)
→ scoring policy resolved (ACTIVE version; bootstrapped once if absent)
→ 4 independent dimensions + policy-weighted priority + threshold outcome
→ ONE transaction: analysis + evidence link + classifications + scores + ai_run
→ ANALYZING → SCORED → THRESHOLD_MAP → QUALIFIED | REVIEW_REQUIRED | REJECTED
```

## Rules

- **Provider-agnostic**: only `AI_PROVIDER`/`AI_BASE_URL`/`AI_API_KEY`/
  `AI_MODEL`/`AI_TIMEOUT_MS`/`AI_MAX_RETRIES`/`AI_RETRY_BACKOFF_MS` decide the
  transport (OpenAI-compatible Chat Completions). No vendor hard-coded.
- **Honest NOT_CONFIGURED**: incomplete configuration fails the job BEFORE the
  ANALYZING transition with `AI_UNAVAILABLE` + `NOT_CONFIGURED` message. The
  lead is untouched and nothing is fabricated.
- **Fake provider**: `AI_PROVIDER=fake` only, refused in production without an
  explicit allowFake opt-in; deterministic and evidence-citing.
- **Evidence-first**: every claim cites evidence ids present in the request;
  unsupported fields are demoted to UNAVAILABLE and reported as uncertain.
- **Scoring**: weights/thresholds come from `scoring_policy_versions`
  (`is_current`/ACTIVE semantics); application code never owns thresholds.
  Five values are always persisted: relevance, audienceQuality, activity,
  confidence, priority.
- **Versioning**: deterministic per-job analysis/score ids; a new run
  supersedes (`is_current=false`, `superseded_at`) — history is never deleted.
- **Idempotency**: duplicate execution of the same job never creates a second
  current analysis/score row (unique partial indexes + deterministic ids +
  `ai_runs.job_id` replay guard).
- **Failures**: `FAILURE_POLICY` decides — RETRY re-arms the job row as
  PENDING with a delayed re-enqueue; REVIEW → lead REVIEW_REQUIRED;
  TERMINAL_FAIL → lead FAILED; AI_PROVIDER_ERROR → deterministic rules
  fallback labelled `rules:fallback` / source `RULE`.
- **Jev stays unplugged**: `DecisionProvider` remains optional; RULES_ONLY and
  LLM_ONLY both work with no Jev dependency.

## API

| Endpoint | Purpose |
|---|---|
| `GET /leads/{leadId}` | lead detail (status, business, identities, classifications) |
| `GET /leads/{leadId}/analysis` | current analysis: universal model + explanation |
| `GET /leads/{leadId}/evidence?analysisId=` | evidence with provenance |
| `GET /leads/{leadId}/scores` | current score (5 dimensions + policy version) |
| `POST /leads/{leadId}/reprocess` | trigger/requeue analysis (idempotent) |

OpenAPI (`docs/api/OPENAPI.yaml`) stays the single source of truth.

## Definition of Done

- `ANALYSIS_PENDING` leads processed by the real worker (no stubs).
- At least one configurable HTTP LLM adapter + deterministic fake provider.
- Evidence, all five score dimensions, policy/version, analysis versioning and
  current-record semantics persisted in PostgreSQL.
- Final state transitions + tenant isolation + retry/idempotency verified.
- Tests: provider/config/validation units, taxonomy/dimension/policy units,
  flow failures, PostgreSQL integration, worker E2E, API contract sync.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` green; DB suites
  green on real PostgreSQL; working tree clean, committed and pushed.
- Docs synced: README, IMPLEMENTATION-PLAN, ROADMAP, AI docs, TASK-CONTRACTS,
  ORCHESTRATION, DATABASE, API/OpenAPI, file tree, ADR-028, MASTER-PROMPT.
