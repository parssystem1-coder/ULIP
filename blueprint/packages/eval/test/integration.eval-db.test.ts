/**
 * Phase 17 integration tests against REAL PostgreSQL (the migrated dev DB).
 *
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:5432/ulip \
 *     node --experimental-strip-types --test packages/eval/test/integration.eval-db.test.ts
 *
 * Without a reachable, migrated database every test SKIPS with an explicit
 * reason — never silently passes.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Database } from '@ulip/runtime';
import { DeterministicFakeLlmProvider } from '@ulip/ai';
import { loadDefaultDataset } from '../src/dataset.ts';
import { runEvaluationDetailed } from '../src/runner.ts';
import { DbEvalStore } from '../src/store.ts';
import { compareRuns } from '../src/regression.ts';

const url = process.env.ULIP_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/ulip';
let db: Database | null = null;
let skipReason = '';
const cleanup: string[] = [];

before(async () => {
  try {
    db = new Database({ connectionString: url, max: 4 });
    const probe = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.evaluation_runs') IS NOT NULL AS present`,
    );
    if (probe.rows[0]?.present !== true) {
      throw new Error('evaluation tables missing — run `pnpm migrate` first');
    }
  } catch (err) {
    db = null;
    skipReason = `PostgreSQL unavailable/unmigrated at ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`\n[SKIP] eval-db integration: ${skipReason}\n`);
  }
});

after(async () => {
  if (db === null) return;
  for (const id of cleanup.reverse()) {
    // Runs/case-results cascade from tenants.
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  }
  await db.close().catch(() => undefined);
});

function withDb(t: { skip(reason: string): void }): Database {
  if (db === null) {
    t.skip(skipReason);
    throw new Error('unreachable');
  }
  return db;
}

async function seedTenant(target: Database): Promise<string> {
  const tenantId = randomUUID();
  cleanup.push(tenantId);
  await target.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [
    tenantId,
    `eval-it-${tenantId.slice(0, 8)}`,
  ]);
  return tenantId;
}

const dataset = loadDefaultDataset();

test('persistRun + findRun roundtrip preserves versions, metrics and case results', async (t) => {
  const target = withDb(t);
  const tenantId = await seedTenant(target);
  const store = new DbEvalStore(target);
  const { record, results } = await runEvaluationDetailed({
    dataset, arm: 'RULES_THEN_LLM', llm: new DeterministicFakeLlmProvider(), tenantId,
  });
  assert.equal(record.tenantId, tenantId);

  const first = await store.persistRun(record, results);
  assert.equal(first.persisted, true);
  // Idempotent replay: the deterministic id converges instead of duplicating.
  const replay = await store.persistRun(record, results);
  assert.equal(replay.persisted, false);

  const loaded = await store.findRun(tenantId, record.runId);
  assert.ok(loaded !== null);
  assert.equal(loaded.runId, record.runId);
  assert.equal(loaded.versions.datasetVersion, '1.0.0');
  assert.equal(loaded.versions.provider, record.versions.provider);
  assert.equal(loaded.versions.taxonomyVersion, 1);
  assert.equal(loaded.arm, 'RULES_THEN_LLM');
  assert.equal(loaded.metrics.totalCases, results.length);
  assert.equal(loaded.metrics.overall.accuracy, record.metrics.overall.accuracy);

  const cases = await store.listCaseResults(tenantId, record.runId);
  assert.equal(cases.length, results.length);
  const ev1 = cases.find((c) => c.caseId === 'ev-001');
  assert.ok(ev1 !== undefined);
  assert.equal(typeof ev1.dimensionAccuracy, 'number');
  const detailOutcomes = (ev1.detail as { outcomes?: unknown[] }).outcomes;
  assert.ok(Array.isArray(detailOutcomes) && detailOutcomes.length === 6);
});

test('evaluation history is append-only: UPDATE and DELETE are rejected by trigger', async (t) => {
  const target = withDb(t);
  const tenantId = await seedTenant(target);
  const store = new DbEvalStore(target);
  const { record } = await runEvaluationDetailed({
    dataset, arm: 'RULES_ONLY', llm: null, tenantId,
  });
  await store.persistRun(record, []);

  await assert.rejects(
    () => target.query(`UPDATE evaluation_runs SET total_cases = 0 WHERE id = $1`, [record.runId]),
    /append-only/,
  );
  await assert.rejects(
    () => target.query(`DELETE FROM evaluation_runs WHERE id = $1`, [record.runId]),
    /append-only/,
  );
});

test('findBaselineRun resolves the previous run of the same arm + dataset', async (t) => {
  const target = withDb(t);
  const tenantId = await seedTenant(target);
  const store = new DbEvalStore(target);
  const { record } = await runEvaluationDetailed({
    dataset, arm: 'RULES_ONLY', llm: null, tenantId,
  });
  await store.persistRun(record, []);
  // A "current" run with a different policy version — the baseline is the stored one.
  const current = { ...record, runId: randomUUID(), versions: { ...record.versions, scoringPolicyVersion: 'policy-v2' } };
  await target.query(
    `INSERT INTO evaluation_runs (id, tenant_id, dataset_version, arm, arm_status, provider, model,
       prompt_version, schema_version, taxonomy_version, scoring_policy_version, started_at, finished_at, total_cases, metrics)
     VALUES ($1,$2,$3,$4,'EXECUTED',$5,$6,$7,$8,$9,$10, now(), now(), 0, $11::jsonb)`,
    [current.runId, tenantId, current.versions.datasetVersion, current.arm,
     current.versions.provider, current.versions.model, current.versions.promptVersion,
     current.versions.schemaVersion, current.versions.taxonomyVersion,
     current.versions.scoringPolicyVersion, JSON.stringify(current.metrics)],
  );
  const baseline = await store.findBaselineRun(tenantId, current);
  assert.ok(baseline !== null);
  assert.equal(baseline.runId, record.runId);

  const report = compareRuns(baseline, current);
  assert.equal(report.findings.length, 0);
  assert.equal(report.hasRegressions, false);
});

test('corrections: appended, listed, never mutating runs; unique per (case, field, reviewer)', async (t) => {
  const target = withDb(t);
  const tenantId = await seedTenant(target);
  const store = new DbEvalStore(target);
  const { record } = await runEvaluationDetailed({
    dataset, arm: 'RULES_ONLY', llm: null, tenantId,
  });
  await store.persistRun(record, []);

  const c1 = await store.addCorrection({
    tenantId, runId: record.runId, caseId: 'ev-001', datasetVersion: '1.0.0',
    field: 'businessType', originalValue: 'Wholesaler', correctedValue: 'Retailer',
    reviewerNote: 'sells retail, not wholesale',
  });
  assert.ok(c1.id.length > 0);
  // Same reviewer + case + field + version is rejected by the unique constraint.
  await assert.rejects(
    () => store.addCorrection({
      tenantId, runId: record.runId, caseId: 'ev-001', datasetVersion: '1.0.0',
      field: 'businessType', originalValue: 'Wholesaler', correctedValue: 'Retailer',
    }),
    /uniq_evaluation_correction|unique constraint/,
  );
  // A different reviewer may disagree (append-only disagreement trail).
  const reviewerB = randomUUID();
  await target.query(
    `INSERT INTO users (id, tenant_id, email, name, role, status) VALUES ($1, $2, $3, 'Reviewer B', 'OWNER', 'ACTIVE')`,
    [reviewerB, tenantId, `reviewer-b-${tenantId.slice(0, 8)}@it.local`],
  );
  await store.addCorrection({
    tenantId, runId: record.runId, caseId: 'ev-001', datasetVersion: '1.0.0',
    field: 'businessType', originalValue: 'Wholesaler', correctedValue: 'Wholesaler',
    reviewerId: reviewerB, reviewerNote: 'I disagree — it is a wholesaler',
  });

  const corrections = await store.listCorrections(tenantId, '1.0.0');
  assert.equal(corrections.length, 2);
  assert.ok(corrections.every((c) => c.caseId === 'ev-001'));
  // The run row is untouched by the corrections.
  const run = await store.findRun(tenantId, record.runId);
  assert.ok(run !== null);
  assert.equal(run.metrics.totalCases, record.metrics.totalCases);
});

test('tenant isolation: another tenant cannot read the run or corrections', async (t) => {
  const target = withDb(t);
  const tenantA = await seedTenant(target);
  const tenantB = await seedTenant(target);
  const store = new DbEvalStore(target);
  const { record } = await runEvaluationDetailed({
    dataset, arm: 'LLM_ONLY', llm: new DeterministicFakeLlmProvider(), tenantId: tenantA,
  });
  await store.persistRun(record, []);
  await store.addCorrection({
    tenantId: tenantA, runId: record.runId, caseId: 'ev-001', datasetVersion: '1.0.0',
    field: 'location', originalValue: 'Tehran', correctedValue: 'Karaj',
  });

  assert.equal(await store.findRun(tenantB, record.runId), null);
  assert.equal((await store.listRuns(tenantB)).length, 0);
  assert.equal((await store.listCaseResults(tenantB, record.runId)).length, 0);
  assert.equal((await store.listCorrections(tenantB, '1.0.0')).length, 0);
  assert.equal((await store.listCorrections(tenantA, '1.0.0')).length, 1);
});

test('feedback export merges corrections into a next-version draft', async (t) => {
  const target = withDb(t);
  const tenantId = await seedTenant(target);
  const store = new DbEvalStore(target);
  await store.addCorrection({
    tenantId, runId: null, caseId: 'ev-001', datasetVersion: '1.0.0',
    field: 'brand', originalValue: ['HP', 'Canon', 'Epson'], correctedValue: ['HP', 'Canon'],
  });
  await store.addCorrection({
    tenantId, runId: null, caseId: 'ev-028', datasetVersion: '1.0.0',
    field: 'outcome', originalValue: 'REJECTED', correctedValue: 'REVIEW_REQUIRED',
  });
  const corrections = await store.listCorrections(tenantId, '1.0.0');
  const draft = store.exportFeedbackDataset(dataset, corrections);
  assert.equal(draft.datasetVersion, '1.1.0-draft');
  assert.match(draft.provenance, /human corrections/);
  const ev1 = draft.cases.find((c) => c.caseId === 'ev-001');
  assert.ok(ev1 !== undefined);
  assert.deepEqual(ev1.expected.brand, ['HP', 'Canon']);
  assert.ok(Array.isArray(ev1.correctionsApplied) && ev1.correctionsApplied.length === 1);
  const ev28 = draft.cases.find((c) => c.caseId === 'ev-028');
  assert.equal(ev28?.expectedOutcome, 'REVIEW_REQUIRED');
  // The base dataset is NOT mutated.
  const ev1Base = dataset.cases.find((c) => c.caseId === 'ev-001');
  assert.deepEqual(ev1Base?.expected.brand, ['HP', 'Canon', 'Epson']);
});
