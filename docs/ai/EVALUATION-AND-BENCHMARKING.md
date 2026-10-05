# AI Evaluation and Benchmarking

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

**Jev-specific rule (ADR-017):** Jev must not be described or promoted as accuracy-improving until a measured benchmark shows it beats the LLM-only arm on the frozen dataset at acceptable cost and review rate.
