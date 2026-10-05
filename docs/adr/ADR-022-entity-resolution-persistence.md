# ADR 022 — Entity Resolution Persistence

## Status
Accepted (remediation 2026-10-04)

## Context
The architecture required deduplication across sources, and the original
MASTER-PROMPT even listed deterministic signals (website, normalized phone),
but the schema had no persistence for candidate matching, decisions or merges.

## Decision
1. `entity_resolution_candidates` stores pairs of businesses with signals,
   similarity and a three-way verdict: SAME_ENTITY / DIFFERENT_ENTITIES /
   UNCERTAIN (never binary).
2. `entity_resolution_matches` records the surviving canonical business;
   `entity_merge_events` records merges (who/why/when) for audit.
3. Deterministic signals (source+external identity, website, normalized
   contact values) propose candidates; uncertain cases route to human review.
4. Uncertain pairs are never auto-merged.

## Consequences
- Every merge is traceable and reversible by policy (merge events retained).
- Cross-source leads attach to one canonical business, feeding the universal
  lead model as designed.
