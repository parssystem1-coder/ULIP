# Orchestration — Analysis Orchestrator & Processing State Machine

Canonical types: `blueprint/packages/orchestration/src/contracts.ts`
(ADR-016). This document mirrors them; when they disagree, the TypeScript wins.

## 1. Ownership

The **Analysis Orchestrator** owns the lead processing lifecycle:

- It is the ONLY component that transitions `leads.status`.
- It creates and persists jobs (DB = truth), then enqueues execution
  (Redis/BullMQ = mechanism).
- Every job execution ends by reporting an event back through the orchestrator,
  which validates it against the transition table before applying.

## 2. Canonical processing graph

    DISCOVERED → RAW_STORED → NORMALIZED → DEDUP_CHECKED → ANALYSIS_PENDING
      → ANALYZING ─┬→ SCORED → (THRESHOLD_MAP) → QUALIFIED | REVIEW_REQUIRED | REJECTED
                   ├→ REVIEW_REQUIRED   (AI unavailable — policy AI_UNAVAILABLE)
                   └→ FAILED            (retry exhausted)

VISION and DECISION are internal steps INSIDE the ANALYZING state — they are
`current_step` values of the ANALYSIS job, not lifecycle states.

## 3. Lead state transition table

| From | Event | To | Actor |
|---|---|---|---|
| DISCOVERED | RAW_STORED | RAW_STORED | discovery job |
| RAW_STORED | NORMALIZED | NORMALIZED | normalization job |
| NORMALIZED | DEDUP_RESOLVED | DEDUP_CHECKED | dedup job |
| DEDUP_CHECKED | QUEUE_ANALYSIS | ANALYSIS_PENDING | orchestrator |
| ANALYSIS_PENDING | ANALYSIS_STARTED | ANALYZING | analysis job |
| ANALYZING | ANALYSIS_SUCCEEDED | SCORED | analysis job (scoring is its last step) |
| SCORED | THRESHOLD_MAP | QUALIFIED / REVIEW_REQUIRED / REJECTED | orchestrator (policy) |
| ANALYZING | ANALYSIS_FAILED | REVIEW_REQUIRED | failure policy: AI_UNAVAILABLE |
| ANALYZING | ANALYSIS_FAILED | FAILED | failure policy: retry exhaustion |
| ANALYZING | RETRY_EXHAUSTED | FAILED | orchestrator |
| REVIEW_REQUIRED | HUMAN_REVIEWED | QUALIFIED / REJECTED | review service |
| SCORED / REVIEW_REQUIRED / REJECTED / QUALIFIED / FAILED | REPROCESS | ANALYSIS_PENDING | orchestrator |
| QUALIFIED / REVIEW_REQUIRED | ARCHIVE | ARCHIVED | review service |

Implementation: `LEAD_TRANSITION_TABLE` + `canTransition()`; undeclared edges
are rejected (no implicit transitions).

## 4. Failure transition table (per error code)

| Error code | Action | Attempts / backoff |
|---|---|---|
| CONNECTOR_ERROR | RETRY | 3 × 30s base, exponential |
| CONNECTOR_UNAVAILABLE | RETRY | 2 × 120s |
| RATE_LIMITED | RETRY | 3 × 60s |
| TIMEOUT | RETRY | 3 × 30s |
| SCHEMA_VALIDATION_ERROR | RETRY | 2 × 5s (bounded repair) |
| UNKNOWN | RETRY | 2 × 30s |
| AI_PROVIDER_ERROR | FALLBACK | next provider/route per decision policy |
| AI_UNAVAILABLE | REVIEW | lead → REVIEW_REQUIRED |
| DATA_UNAVAILABLE | SKIP | record availability, continue |
| INVALID_DATA | TERMINAL_FAIL | lead → FAILED with error |
| CANCELLED | TERMINAL_FAIL | — |

(Database-unavailable is out of the map: with the DB as source of truth, that
failure is handled at process level by supervisor + alerting.)

## 5. Orchestrator responsibilities (decision list)

- **Who creates the next job**: the orchestrator, on a validated success event
  of the previous step (no job self-chains).
- **Job success**: all steps of the job's type completed AND result rows
  committed in one transaction (e.g. analysis+evidence, ADR-024).
- **Skip**: DATA_UNAVAILABLE (or capability absent) → mark SKIPPED with reason;
  lead continues its lifecycle with availability metadata set.
- **Partial success**: connector returns `partial=true` → job SUCCEEDS with
  warnings persisted on job_events; discovery continues with available data.
- **AI unavailable**: per failure table → fallback route if configured,
  else lead → REVIEW_REQUIRED (never silent rejection).
- **Connector unavailable**: retry policy; exhaustion → lead FAILED
  (reprocessable).
- **Schema validation failure**: bounded repair/retry (2 attempts), then
  AI_PROVIDER_ERROR path (fallback), never persisted as valid.
- **Retry exhaustion**: attempts = max_attempts → job FAILED, error_code kept,
  lead FAILED; resumable via REPROCESS.
- **Human review required**: threshold mapping (policy) or AI_UNAVAILABLE →
  REVIEW_REQUIRED; the pipeline PAUSES (no further jobs) until HUMAN_REVIEWED.
- **Resume**: `resume(tenantId, leadId)` reads the lead's persisted status and
  re-enqueues the correct next job (crash recovery path; idempotent).
- **Reprocess**: creates a REPROCESS job (parent_job_id = original); new
  analysis/score versions become current atomically; old versions stay
  auditable (ADR-024).
- **Cancellation**: `cancel(jobId)` sets CANCEL_REQUESTED (job_events); workers
  check between steps and finalize as CANCELLED; lead returns to its pre-job
  state. Cooperative, at step boundaries.

## 6. Progress semantics

`progress` (0–100) is step-weighted per job type and updated via PROGRESS
job_events; API `GET /discovery/jobs/{id}` reads the DB row, never Redis.
