# ADR-029 — AI Evaluation, Calibration & Regression Framework

Status: accepted (Phase 17)

## Context

Phase 16 shipped the real AI analysis runtime (evidence → extraction → taxonomy
mapping → policy scoring). Nothing measures whether it classifies well, whether
its confidence is honest, or whether a provider/prompt/policy change makes
things worse. The benchmarking principles in
[EVALUATION-AND-BENCHMARKING.md](../ai/EVALUATION-AND-BENCHMARKING.md) existed
without any implementation.

## Decision

1. **Human-labeled dataset in the repository.**
   `packages/eval/dataset/eval-dataset-v1.json` (v1.0.0, 34 cases) carries
   hand-written labels against a frozen taxonomy snapshot (seed 001 + two
   dataset-scoped specialty nodes) and covers all six business types,
   industries, specialties, a sub-specialty, brands, Persian/English/mixed
   text, Arabic-variant spellings, ZWNJ, ambiguous businesses, weak/strong
   evidence, missing location, inactive accounts and noisy audiences —
   including both canonical examples (HP printer-parts wholesaler in Tehran;
   Shiraz balayage salon). The loader rejects datasets whose provenance is not
   human or whose labels drift from the frozen snapshot.

2. **Evaluation is measurement, not a second AI stack.** `@ulip/eval` reuses
   `@ulip/ai` providers, the `@ulip/analysis` evidence pipeline
   (`buildEvidenceDrafts` → `ProfileExtractionInput`), `computeDimensions`,
   and `@ulip/scoring` policy scoring. No duplicated AI contracts.

3. **Five arms, honest availability.** RULES_ONLY (deterministic alias rules
   over the same evidence), LLM_ONLY, RULES_THEN_LLM (rules fill gaps),
   LLM_THEN_DECISION_PROVIDER and RULES_LLM_DECISION_PROVIDER (bounded Jev
   arbitration over per-dimension candidates). Arms execute only when their
   providers are configured; otherwise the run is recorded `NOT_CONFIGURED`
   with the reason — never fabricated. No DecisionProvider exists in the repo,
   so Jev arms stay NOT_CONFIGURED until Phase ≥18.

4. **Deterministic run identity.** `runId = uuid5(tenant, datasetVersion, arm,
   provider, model, promptVersion, schemaVersion, taxonomyVersion,
   scoringPolicyVersion)` — re-running the same evaluation converges on the
   same row (idempotent upsert), and changing any version tuple produces a new
   run.

5. **Append-only history.** `evaluation_runs`, `evaluation_case_results` and
   `evaluation_corrections` (migration 0004) are tenant-scoped; UPDATE/DELETE
   on runs/case results is rejected by trigger. Corrections are separate rows
   that never overwrite AI output; a disagreement between reviewers is another
   row, not an edit.

6. **Metrics are per-dimension and per-category.** Accuracy/micro
   precision/recall/F1, confusion matrix, abstention/coverage, calibration
   (5 buckets, ECE, over-confidence), latency, cost (null without provider
   usage metadata), the §5 error taxonomy with runner-side TAXONOMY_MISMATCH
   refinement, and score diagnostics (separation of human-QUALIFIED vs
   human-REJECTED priority, zero-share dominance, cross-dimension
   correlation). Release gating uses per-category regression findings
   (CRITICAL ≥ 0.10, MAJOR ≥ 0.05, MINOR > 0.02), never overall accuracy alone.

7. **Baseline + regression command.** `pnpm eval` runs the executable arms
   with the deterministic fake provider by default, compares each run against
   the committed baseline (`packages/eval/baselines/*`) or the most recent DB
   run of the same arm + dataset version, and exits non-zero when
   CRITICAL/MAJOR regressions exist. Live-provider evaluation requires
   `ULIP_EVAL_LIVE=1` **and** a configured HTTP provider; tests never call
   external APIs.

8. **Minimum read API.** `GET /evaluation/runs`, `/evaluation/runs/{runId}`,
   `/evaluation/runs/{runId}/regression`, `/evaluation/corrections` (GET/POST)
   and `/evaluation/feedback-dataset` expose structured results only — no
   chain-of-thought.

## Non-goals

No real Jev provider, no automatic weight/threshold/model changes, no
fine-tuning, no GNN/image/outreach/scraping work, no replacement of AI
contracts, no deletion of historical results.

## Consequences

- Model/prompt/policy changes are compared against a reproducible baseline at
  per-category granularity before promotion decisions.
- Calibration and score-diagnostics are measured first; threshold changes
  remain a human decision informed by (not automated from) these reports.
- Corrections accumulate into a feedback dataset draft
  (`exportFeedbackDataset`) that seeds the next human labeling round.
