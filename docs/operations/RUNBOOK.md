# Operations Runbook

## Symptom: discovery jobs stuck

1. Check queue depth and worker health.
2. Inspect failed jobs.
3. Check source connector health/capability state.
4. Verify Redis connectivity.
5. Do not blindly replay all failed jobs.

## Symptom: AI failure spike

1. Compare by provider/model.
2. Check schema-validation failures separately from network/provider failures.
3. Confirm fallback routing.
4. Review cost/latency impact before increasing concurrency.

## Symptom: database latency

1. Inspect query metrics.
2. Check missing indexes and query plans.
3. Check connection pool saturation.
4. Avoid introducing a new database technology before proving the bottleneck.

## Symptom: incorrect classifications

1. Inspect evidence.
2. Determine whether source data was ambiguous or missing.
3. Compare model version and taxonomy version.
4. Add representative labeled cases to the evaluation set.
5. Only then change prompts/models/scoring.
