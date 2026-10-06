# Scoring Engine

## 1. Score scale

Default display scale: 0–100.

Internally, evidence may be normalized to a 0–1 representation before display.

## 2. Lead Relevance

Possible inputs:

- profession match
- specialty match
- city match
- current search intent match
- content relevance

## 3. Business Activity

Possible inputs:

- recency of available content
- posting frequency where reliable
- recent engagement signals where permitted
- profile completeness

## 4. Audience Quality

This is an estimate of audience quality/risk. It must be expressed as a quality/risk signal with uncertainty, not as a guaranteed classification of individual followers.

## 5. Data Confidence

Possible inputs:

- explicitness of evidence
- source completeness
- agreement between independent signals
- model confidence
- human confirmation

## 6. Overall Priority

Default conceptual formula:

```text
Priority = weighted(Relevance, AudienceQuality, Activity, Confidence)
```

The exact weights are configuration and are versioned with the score.

## 7. Thresholds

Thresholds map scores/confidence to workflow states. They are code/config policy, not AI output.

## Policy persistence (ADR-021)

Weights and thresholds are **configuration, not code**: they live in the
`scoring_policies` / `scoring_policy_versions` tables (versioned, effective-dated,
per-tenant) and are resolved at runtime by `@ulip/scoring` `resolvePolicy()`
(effective active version, deterministic tie-breaking). No threshold in this
document is authoritative over the persisted policy; this document describes the
model, the tables hold the values. The five configurable dimensions — Lead
Relevance, Audience Quality, Business Activity, Data Confidence, Overall Priority —
are each independently configurable. Decision thresholds (accept/review/reject)
live in `decision_policies` (ADR-021).

## Implemented runtime (Phase 16, ADR-028)

`@ulip/analysis` `computeDimensions()` (`blueprint/packages/analysis/src/dimensions.ts`)
computes the five dimensions **independently** and never collapses them into an
unexplained number:

1. **Lead Relevance** — taxonomy business-type/industry match, specialty match,
   city match, profile completeness.
2. **Audience Quality** — signals available on the lead, always reported with
   uncertainty; absence of signals scores 0 and says so.
3. **Business Activity** — recency/frequency/engagement signals; absent signals
   score 0 explicitly, never a fabricated default.
4. **Data Confidence** — how much of the input was actually AVAILABLE and how
   strong the evidence behind each prediction was.
5. **Overall Priority** — `weighted(relevance, audience, activity, confidence)`
   using the weights from the persisted ACTIVE `scoring_policy_versions` row.

Every dimension emits `contributions[]` with the evidence ids that support it,
so `GET /leads/{leadId}/scores` plus `GET /leads/{leadId}/evidence` explain
high/low values. Review/accept/reject comes from the policy's persisted
thresholds (`resolvePolicy()` in `@ulip/scoring`) — application code contains no
threshold constants. The `scoring_policy_version_id` is stored on every
`lead_scores` row, and the row follows ADR-024 current-version semantics.
