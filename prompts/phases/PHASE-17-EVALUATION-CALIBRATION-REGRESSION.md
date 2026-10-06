# PHASE 17 — AI EVALUATION, CALIBRATION & REGRESSION FRAMEWORK (implemented)

Goal: a reproducible framework that measures the real quality of ULIP
classification and scoring instead of assuming any provider, prompt or Jev
strategy is better. The AI architecture was not redesigned (ADR-029).

## Shipped

1. **Dataset** — `blueprint/packages/eval/dataset/eval-dataset-v1.json`
   (v1.0.0): 34 human-labeled cases against a frozen taxonomy snapshot
   (taxonomyVersion 1). Covers Wholesaler / Retailer / Service Provider /
   Manufacturer / Distributor / Professional, industries, specialties, a
   sub-specialty, brands, Persian, English, mixed, Arabic-variant spellings,
   ZWNJ, ambiguous, weak/strong evidence, missing location, inactive, noisy
   audience — plus both canonical examples (HP printer-parts wholesaler in
   Tehran; Shiraz coloring/balayage salon). Loader-enforced human provenance.
2. **Contracts** — `@ulip/eval` typed dataset/case/result/metric/regression
   shapes (no `unknown` in public contracts, ADR-023): dataset version, case
   id, expected vs actual labels, provider/model/prompt/schema/taxonomy/policy
   versions, confidence, latency, token/cost metadata when available,
   abstention, per-case error category.
3. **Metrics** — per-dimension (businessType, industry, specialty,
   subSpecialty, brand, location) and aggregate: accuracy, micro
   precision/recall/F1, confusion matrix, abstention rate, coverage,
   calibration (5 confidence buckets, ECE, over-confidence), latency p50/p95,
   cost per case (null without provider metadata), outcome accuracy,
   per-tag breakdowns, score diagnostics (separation, zero-share dominance,
   cross-dimension correlation, outcome correlation).
4. **Error taxonomy** — every failed case attributed to SOURCE_DATA_MISSING /
   NORMALIZATION_ERROR / TAXONOMY_MISMATCH / MODEL_MISUNDERSTANDING /
   GROUNDING_FAILURE / THRESHOLD_ERROR / SCORING_ERROR /
   HUMAN_LABEL_DISAGREEMENT / OTHER. No generic "AI error".
5. **Arms** — RULES_ONLY, LLM_ONLY, RULES_THEN_LLM,
   LLM_THEN_DECISION_PROVIDER, RULES_LLM_DECISION_PROVIDER. Executed only when
   configured; otherwise recorded NOT_CONFIGURED with the reason. Jev is not
   implemented (no DecisionProvider in the repo) — the two Jev arms run only
   against an injected DecisionProvider in tests.
6. **Providers** — deterministic fake provider (default), mocked HTTP provider
   (injectable fetch), optional live evaluation via
   `ULIP_EVAL_LIVE=1 + AI_PROVIDER=http` through the same runner. Tests never
   require live credentials.
7. **Regression harness** — `pnpm eval` runs the executable arms, persists
   runs (when `ULIP_PG_URL` is reachable), compares against the committed
   baseline (`packages/eval/baselines/baseline-*-v1.json`) and exits non-zero
   on CRITICAL/MAJOR regressions. Findings are per-metric dotted paths
   (overall/byDimension/byTag/calibration/abstention/latency).
8. **Baseline** — committed, byte-stable (`--stable` zeroes wall-clock
   timestamps; classification metrics and run ids are deterministic).
9. **Human corrections** — append-only `evaluation_corrections` (tenant,
   dataset version, case, field, original vs corrected, reviewer, note);
   never overwrite AI output; feedback export
   (`exportFeedbackDataset`, GET `/evaluation/feedback-dataset`) produces the
   next-version labeled draft (no fine-tuning).
10. **Read API** — GET /evaluation/runs, /evaluation/runs/{runId},
    /evaluation/runs/{runId}/regression, /evaluation/corrections,
    POST /evaluation/corrections. Structured results only; no
    chain-of-thought.
11. **Database** — migration `0004_evaluation`: tenant-scoped, append-only
    (trigger-enforced), deterministic run ids, version columns. `ai_runs` is
    not duplicated.

## Gates (all passing at implementation time)

`pnpm typecheck` · `pnpm lint` · `pnpm test` (incl. real-PostgreSQL
integration tests; skips honestly without `ULIP_PG_URL`) · `pnpm build` ·
OpenAPI validation · `pnpm eval` release gate PASS.
