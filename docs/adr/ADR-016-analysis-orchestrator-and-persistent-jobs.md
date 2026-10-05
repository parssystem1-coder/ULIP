# ADR 016 — Analysis Orchestrator and Persistent Job State

## Status
Accepted (remediation 2026-10-04)

## Context
The blueprint described many pipeline jobs (discovery, normalization, analysis,
vision, decision, scoring, export) but no owner of the processing state machine,
and no durable job persistence: the original schema had no job tables at all
while the API promised `GET /discovery/jobs/:jobId` with progress.

## Decision
1. An **Analysis Orchestrator** owns the lead processing lifecycle and is the
   only writer of lead lifecycle transitions.
2. The **database** (jobs / job_attempts / job_events + leads.status) is the
   source of truth for long-lived processing state. Redis/BullMQ remains the
   execution mechanism only.
3. The canonical lead state machine, transition table, failure table and retry
   policy live in `blueprint/packages/orchestration/src/contracts.ts` and are
   mirrored in `docs/architecture/ORCHESTRATION.md`.

## Consequences
- Jobs survive worker restarts; state can always be reconciled from the DB.
- Resume/reprocess/cancel semantics are explicit (see ORCHESTRATION.md tables).
- Every (from, event) transition is declared; invalid moves are rejected.

## Review trigger
If BullMQ primitives prove insufficient for step-level orchestration in Phase 6,
revisit the execution binding — not the ownership decision.
