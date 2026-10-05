# ADR 021 — Scoring and Decision Policy Persistence

## Status
Accepted (remediation 2026-10-04)

## Context
Multiple documents required "configurable" scoring weights and confidence
thresholds, but no storage existed — thresholds lived in prose only.

## Decision
1. `scoring_policies` + `scoring_policy_versions` store per-tenant weights and
   thresholds with effective dating; the resolved version is stamped on every
   `lead_scores` row (`scoring_policy_version_id`).
2. `decision_policies` + `decision_policy_versions` store accept/review/
   reject/fallback thresholds AND the decision strategy
   (`use_decision_provider`, `decision_strategy`) — making Jev optional by
   configuration (ADR-017).
3. Pure resolution logic lives in `@ulip/scoring/policy-resolver` (effective
   dating, latest-wins, weight validation) and is unit-tested.
4. No threshold may appear only in code or prose; unversioned constants in the
   domain are a review blocker.

## Consequences
- Priority/threshold behavior changes are data changes with audit history.
- Score comparisons across time are exact (policy version on each row).
