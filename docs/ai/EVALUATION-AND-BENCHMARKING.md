# AI Evaluation and Benchmarking

> **Status (Phase 17, ADR-029): implemented.** The framework lives in
> `blueprint/packages/eval` (`@ulip/eval`). Dataset:
> `packages/eval/dataset/eval-dataset-v1.json` (v1.0.0, 34 human-labeled
> cases). Command: `pnpm eval` (baseline comparison + release gate;
> `ULIP_EVAL_LIVE=1` opts into the configured HTTP provider). Read API:
> `GET /evaluation/runs[/{runId}[/regression]]`, `/evaluation/corrections`,
> `/evaluation/feedback-dataset`. The protocol below is now enforced by code,
> not by convention.

## 1. Benchmark principle

Do not assume that LLM-only, Jev-only or cascaded inference is universally best. Benchmark the actual business tasks on a human-labeled dataset.

## 2. Dataset

Create a representative labeled set covering:

- business types (Wholesaler, Service Provider, Manufacturer, Distributor, …)
- industries and specialties
- brand mentions (e.g. "HP printer parts")
- Persian and English text, including ZWNJ and Arabic/Persian character variants (ADR-019)
- ambiguous profiles
- multilingual text
- weak evidence
- strong evidence
- missing location
- inactive businesses
- noisy/suspicious audience signals

## 3. Comparison arms

- Deterministic rules only (baseline floor)
- LLM only
- Jev only where applicable
- LLM → Jev
- Rules → LLM
- Rules → LLM → Jev
- Human baseline / adjudicated label

## 4. Metrics

- accuracy
- precision
- recall
- F1
- confusion matrix
- review / abstention rate
- coverage (share of items answered without abstention)
- calibration error where appropriate
- cost per lead
- latency
- error distribution (share of failures per category of §5)

## 5. Error taxonomy

Record whether a failure came from:

- source data missing
- normalization
- taxonomy mismatch
- model misunderstanding
- grounding failure
- decision threshold
- scoring formula
- human labeling disagreement

## 6. Protocol

1. Freeze a versioned, human-labeled dataset (stored with the repo's evaluation assets).
2. Fix prompt versions, model versions and routing per arm (ADR-021 decision policies).
3. Run every arm over the full dataset; record all §4 metrics per arm plus per-category breakdowns.
4. Store results in `ai_runs`-backed evaluation records with model/prompt/taxonomy/policy versions (ADR-017).

## 7. Release gate

A new model/routing policy should not become default solely because overall accuracy improved. Examine regressions on high-value categories, cost, review burden and calibration.

In Phase 17 this is mechanical: `pnpm eval` compares every run against the
committed baseline per metric path (`overall.*`, `byDimension.*`, `byTag.*`,
calibration, abstention, latency). CRITICAL (≥0.10) or MAJOR (≥0.05)
degradations fail the gate; MINOR (>0.02) degradations are reported. Jev arms
are recorded `NOT_CONFIGURED` until a real DecisionProvider exists.

**Jev-specific rule (ADR-017):** Jev must not be described or promoted as accuracy-improving until a measured benchmark shows it beats the LLM-only arm on the frozen dataset at acceptable cost and review rate.

## 8. Content & multimodal arms (Phase 18, ADR-030)

Four comparison arms quantify how much content evidence contributes over the
profile-only floor (same dataset, same labels, same scoring policy):

| Arm | Evidence visible |
| --- | --- |
| `PROFILE_ONLY` | profile text only (no content at all) |
| `TEXT_CONTENT` | profile + sampled captions (STANDARD budget) |
| `TEXT_IMAGE` | TEXT_CONTENT + budget-capped Vision step (2 images) |
| `FULL_AVAILABLE_EVIDENCE` | everything available (DEEP budget, 4 images) |

Arms run through the REAL production pipeline pieces: `sampleContents` over the
case contents, `buildContentEvidenceDrafts`, `planVision`/`runVisionStep` (the
same `VisionProvider` slot the worker uses), then the same LLM extraction and
`@ulip/scoring` policy evaluation as the Phase 17 arms. `TEXT_IMAGE` and
`FULL_AVAILABLE_EVIDENCE` require a VisionProvider; without one they are
recorded `NOT_CONFIGURED` with zero cases — never fabricated. Baselines for all
arms are committed (`packages/eval/baselines/baseline-*.json`) and enforced by
the same CRITICAL/MAJOR regression gate.

Measured on dataset v1.0.0 with the deterministic fake providers (34 cases):
PROFILE_ONLY macroF1 ≈ 0.797 (coverage 0.72) vs TEXT_CONTENT / TEXT_IMAGE /
FULL_AVAILABLE_EVIDENCE macroF1 ≈ 0.804 (coverage 0.752) — adding content
raises coverage and abstention drops accordingly; exact numbers are stamped in
the committed baselines for regression comparison.
