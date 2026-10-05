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
