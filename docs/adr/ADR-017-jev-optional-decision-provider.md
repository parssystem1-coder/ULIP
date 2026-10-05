# ADR 017 — Jev as an Optional Decision Provider

## Status
Accepted (remediation 2026-10-04). Amends ADR-007 (LLM/Jev separation): the
separation stands; Jev is demoted from assumed pipeline stage to optional,
policy-selected capability.

## Context
The original blueprint referenced "Jev" throughout without a precise contract
and risked making an undefined component a hard dependency. ADR-007 itself
required benchmarking before claiming benefit.

## Decision
1. DecisionProvider is a **typed, optional capability**
   (`blueprint/packages/ai/src/interfaces.ts`) with a strict probability
   contract enforced by the AI gateway (range, completeness, sum-to-1, no
   positional A/B/C keys).
2. Strategies are tenant policy (`decision_policy_versions.decision_strategy`):
   RULES_ONLY, LLM_ONLY, DECISION_PROVIDER_ONLY, LLM_THEN_DECISION_PROVIDER,
   RULES_THEN_LLM, RULES_LLM_DECISION_PROVIDER. The platform must fully operate
   with RULES_ONLY/LLM_ONLY — no DecisionProvider configured.
3. The application owns thresholds and workflow; the provider never does.
4. No accuracy claim is made for Jev until measured (EVALUATION-AND-BENCHMARKING).

## Consequences
- Adding/removing a decision provider is a registry change, not a domain change.
- Prompt/example text referencing Jev as mandatory is removed or qualified.
