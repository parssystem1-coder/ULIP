# ADR 024 — Current Analysis/Score Semantics, Evidence Write Order, and DB-Enforced Status

## Status
Accepted (remediation 2026-10-04)

## Context
`lead_analyses`/`lead_scores` could accumulate versions with no definition of
"current"; the API filter `minRelevance` had no documented query path; the AI
extraction contract referenced evidence IDs before evidence could exist; and
lifecycle values were free-form TEXT.

## Decision
1. **Current version**: `is_current` boolean + `superseded_at` timestamp with
   a partial unique index — exactly one current analysis and one current score
   per lead. List filtering (`GET /leads?minRelevance=`) joins/queries the
   partial index directly; no ad-hoc window queries.
2. **Evidence write order**: evidence is created INSIDE the analysis
   transaction, before the analysis row is marked current:
   Analysis Run → Structured Extraction → Evidence Creation → Attach
   evidenceIds → Validation → Mark current (+ Decision). Evidence rows carry
   `analysis_id`; orphan analyses/evidence are impossible by FK design, and a
   failed step leaves the previous current version intact.
3. **Status enforcement**: lifecycle values are Postgres enums
   (`lead_status`, etc.). Transitions are owned by the orchestrator
   (ADR-016); the database rejects out-of-model values.
4. Reprocessing supersedes the current version atomically (retire → insert)
   and keeps old versions for the retention window.

## Consequences
- "Current" is a DB invariant, testable in CI (db-constraints suite).
- Broken evidence references cannot be persisted by design.
