# ADR-028: AI Analysis & Scoring Runtime

- Status: Accepted
- Phase: 16
- Date: 2026-10-06

## Context

Phases 14–15 delivered the runtime, the persistent Job model and a real
discovery pipeline that ends in `ANALYSIS_PENDING`. The typed AI contracts
(`@ulip/ai`), the five-dimension scoring model (`@ulip/scoring`) and the
canonical state machine (`@ulip/orchestration`) existed as contracts only — no
code connected them, so leads never reached `SCORED`/`QUALIFIED`.

Constraints: reuse the existing contracts, schema, policies and transition
table; keep Jev (DecisionProvider) optional; never fabricate AI results.

## Decisions

1. **New `@ulip/analysis` package owns the runtime, not a new platform layer.**
   It depends on `@ulip/ai`, `@ulip/scoring`, `@ulip/orchestration`,
   `@ulip/domain` and `@ulip/runtime`. No microservices, no second contract.

2. **Provider selection is a pure factory (`selectAiRuntime`) with two honest
   states**: `READY` and `NOT_CONFIGURED`. The HTTP adapter speaks
   OpenAI-compatible Chat Completions against `AI_BASE_URL`; no vendor is
   hard-coded. NOT_CONFIGURED is detected *before* the `ANALYZING`
   transition, so a missing credential never moves a lead and never produces
   an analysis row.

3. **The deterministic fake provider is test/dev only.** It requires
   `AI_PROVIDER=fake` and is additionally refused when `NODE_ENV=production`
   without an explicit `allowFake` opt-in. It cites only evidence samples that
   literally contain the matched signal, so it cannot invent facts.

4. **Evidence-first is enforced twice.** The provider is told to cite only the
   provided sample ids; `validateExtractionOutput` rejects unknown/missing
   citations, and `enforceEvidenceFirst` demotes anything unsupported to
   `UNAVAILABLE` (kept visible as an uncertain field, never as a fact).

5. **Scoring stays policy-owned.** `DbScoringPolicyResolver` loads the ACTIVE
   `scoring_policy_versions` row (`resolvePolicy`) and bootstraps the
   documented default (identical to `database/seeds/002_policies_example.sql`)
   exactly once when a tenant has none. Thresholds are never read from
   application code; the score row stores `scoring_policy_version_id`.

6. **One transaction per run (ADR-024).** Analysis row, evidence link,
   classifications, both current-version supersessions, audience quality and
   `ai_runs` commit together. Ids are deterministic per `(jobId, leadId)`, so a
   duplicate execution collides instead of duplicating; historical rows are
   superseded (`is_current=false`, `superseded_at`), never deleted.

7. **The orchestrator is the only writer of `leads.status`.** `DbOrchestrator`
   validates against `LEAD_TRANSITION_TABLE` and applies conditional updates
   (`expectedFrom` + tenant). Controllers never transition leads; they call
   `reprocess()` which persists the job first, then enqueues (transport only).

8. **Failure handling uses the existing FAILURE_POLICY.** RETRY re-arms the
   job row as `PENDING` with `run_after` and a delayed transport re-enqueue
   (`job_attempts` + `RETRY_SCHEDULED` events); exhausted retries move the lead
   to `FAILED`; `AI_UNAVAILABLE` moves it to `REVIEW_REQUIRED`;
   `AI_PROVIDER_ERROR` falls back to the deterministic rules engine labelled
   `rules:fallback` with classification source `RULE`.

9. **Explainability is structured, not chain-of-thought.** `structured_output`
   stores the universal business model, per-dimension reasons with evidence
   ids, uncertain fields and provider/prompt/schema/job metadata. The API
   exposes it through `GET /leads/{leadId}/analysis`.

## Consequences

- Leads reach `QUALIFIED`/`REVIEW_REQUIRED`/`REJECTED` through the real worker
  with traceable evidence and policy-versioned scores.
- Operators must configure `AI_*` variables for real AI runs; without them the
  system fails honestly (`AI_UNAVAILABLE` / NOT_CONFIGURED) instead of
  pretending.
- Vision/embedding slots exist but stay `null` unless configured; image-level
  analysis remains a future phase.
- Jev remains unplugged: `DecisionProvider` is optional by construction.
