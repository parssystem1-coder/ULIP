/**
 * Phase 16 integration test against REAL PostgreSQL (the migrated dev DB).
 *
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:5432/ulip \
 *     node --experimental-strip-types --test packages/analysis/test/integration.analysis-db.test.ts
 *
 * Without a reachable, migrated database every test SKIPS with an explicit
 * reason — never silently passes.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Database } from '@ulip/runtime';
import { selectAiRuntime, loadAiConfig } from '@ulip/ai';
import { DbOrchestrator, TransitionError } from '@ulip/orchestration';
import { runAnalysisForLead } from '../src/flow.ts';
import { AnalysisSkipError } from '../src/contracts.ts';
import { DbAnalysisStore } from '../src/store.ts';
import { DbScoringPolicyResolver } from '../src/policy.ts';
import { memoryLog } from './fakes.ts';

const url = process.env.ULIP_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/ulip';
let db: Database | null = null;
let skipReason = '';
const cleanup: string[] = [];

before(async () => {
  try {
    db = new Database({ connectionString: url, max: 4 });
    const probe = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.leads') IS NOT NULL AS present`,
    );
    if (probe.rows[0]?.present !== true) {
      throw new Error('schema not migrated — run `pnpm migrate` first');
    }
  } catch (err) {
    db = null;
    skipReason = `PostgreSQL unavailable/unmigrated at ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`\n[SKIP] analysis-db integration: ${skipReason}\n`);
  }
});

after(async () => {
  if (db === null) return;
  for (const id of cleanup.reverse()) {
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  }
  await db.close().catch(() => undefined);
});

function withDb(t: { skip(reason: string): void }): boolean {
  if (db === null) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

interface Fixture {
  tenantId: string;
  leadId: string;
  jobId: string;
  wholesalerId: string;
}

async function seed(target: Database): Promise<Fixture> {
  const tenantId = randomUUID();
  cleanup.push(tenantId);
  await target.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `analysis-it-${tenantId.slice(0, 8)}`]);
  const src = randomUUID();
  await target.query(
    `INSERT INTO sources (id, tenant_id, type, name) VALUES ($1, $2, 'FAKE', 'it-src')`,
    [src, tenantId],
  );
  const wholesalerId = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, NULL, 'BUSINESS_TYPE', 'Wholesaler', 'wholesaler')`,
    [wholesalerId, tenantId],
  );
  const industryId = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, $3, 'INDUSTRY', 'Printing', 'printing')`,
    [industryId, tenantId, wholesalerId],
  );
  const specId = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, $3, 'SPECIALTY', 'Printer Parts', 'printer-parts')`,
    [specId, tenantId, industryId],
  );
  await target.query(
    `INSERT INTO taxonomy_node_aliases (node_id, alias, alias_norm, locale)
     SELECT $1, 'قطعات پرینتر', 'قطعات پرینتر', 'fa'
     WHERE NOT EXISTS (
       SELECT 1 FROM taxonomy_node_aliases WHERE alias_norm = 'قطعات پرینتر' AND locale = 'fa')`,
    [specId],
  );

  const bizId = randomUUID();
  await target.query(
    `INSERT INTO businesses (id, tenant_id, canonical_name) VALUES ($1, $2, 'چاپخانه تهران')`,
    [bizId, tenantId],
  );
  const leadId = randomUUID();
  await target.query(
    `INSERT INTO leads (id, tenant_id, business_id, status) VALUES ($1, $2, $3, 'ANALYSIS_PENDING')`,
    [leadId, tenantId, bizId],
  );
  await target.query(
    `INSERT INTO lead_identities (lead_id, source_id, external_id, username, profile_url, display_name)
     VALUES ($1, $2, 'username:chap_tehran', 'chap_tehran', 'https://example.test/chap_tehran', 'چاپخانه تهران')`,
    [leadId, src],
  );
  const rawId = randomUUID();
  await target.query(
    `INSERT INTO raw_entities (id, source_id, external_id, entity_type, payload_json, content_hash, ingest_status, collected_at)
     VALUES ($1, $2, 'fake-001', 'BUSINESS_PROFILE', $3, 'hash-it', 'PROCESSED', now())`,
    [rawId, src, JSON.stringify({
      username: 'chap_tehran', full_name: 'چاپخانه تهران',
      biography: 'عمده‌فروش قطعات پرینتر HP', category: 'WHOLESALE',
      city: 'تهران', brand: 'HP', followers_count: 1500,
    })],
  );
  await target.query(
    `INSERT INTO raw_entity_currents (source_id, external_id, raw_entity_id) VALUES ($1, 'fake-001', $2)`,
    [src, rawId],
  );
  const jobId = randomUUID();
  await target.query(
    `INSERT INTO jobs (id, tenant_id, type, payload) VALUES ($1, $2, 'ANALYSIS', $3)`,
    [jobId, tenantId, JSON.stringify({ leadId, analysisMode: 'STANDARD', reason: 'it' })],
  );
  return { tenantId, leadId, jobId, wholesalerId };
}

const OTHER = randomUUID();

function deps(target: Database) {
  const store = new DbAnalysisStore(target);
  const policy = new DbScoringPolicyResolver(target);
  const orchestrator = new DbOrchestrator({ db: target });
  const ai = selectAiRuntime(loadAiConfig({ AI_PROVIDER: 'fake', NODE_ENV: 'test' } as NodeJS.ProcessEnv));
  return {
    store,
    policy,
    orchestrator,
    deps: { log: memoryLog, store, policy, lifecycle: orchestrator, ai },
  };
}

test('real PostgreSQL: full analysis run persists evidence, scores and transitions', async (t) => {
  if (!withDb(t) || db === null) return;
  const f = await seed(db);
  const { deps: flowDeps, policy } = deps(db);

  const outcome = await runAnalysisForLead(flowDeps, { leadId: f.leadId }, {
    tenantId: f.tenantId, jobId: f.jobId, correlationId: null,
  });

  const lead = await db.query<{ status: string }>('SELECT status::text AS status FROM leads WHERE id = $1', [f.leadId]);
  assert.equal(lead.rows[0]?.status, outcome.finalStatus);
  assert.equal(['QUALIFIED', 'REVIEW_REQUIRED', 'REJECTED'].includes(outcome.reviewOutcome), true);

  const analyses = await db.query<{ id: string; is_current: boolean; analysis_version: string }>(
    'SELECT id, is_current, analysis_version FROM lead_analyses WHERE lead_id = $1', [f.leadId],
  );
  assert.equal(analyses.rowCount, 1);
  assert.equal(analyses.rows[0]?.is_current, true);
  assert.ok((analyses.rows[0]?.analysis_version ?? '').includes(f.jobId.slice(0, 8)));

  const evidence = await db.query<{ n: string; linked: string }>(
    `SELECT count(*)::text AS n, count(analysis_id)::text AS linked FROM evidence WHERE lead_id = $1`,
    [f.leadId],
  );
  assert.ok(Number(evidence.rows[0]?.n ?? '0') >= 4, 'evidence rows persisted');
  assert.equal(evidence.rows[0]?.n, evidence.rows[0]?.linked, 'every evidence row linked to its analysis');

  const classes = await db.query<{ type: string; node: string | null; source: string }>(
    `SELECT classification_type::text AS type, taxonomy_node_id::text AS node, source::text AS source
     FROM lead_classifications WHERE lead_id = $1`, [f.leadId],
  );
  const bt = classes.rows.find((c) => c.type === 'BUSINESS_TYPE');
  assert.equal(bt?.node, f.wholesalerId, 'existing taxonomy node reused');
  assert.equal(bt?.source, 'AI');
  assert.ok(classes.rows.some((c) => c.type === 'BRAND' && c.node === null), 'brand stays free text');
  assert.ok(classes.rows.some((c) => c.type === 'OTHER'), 'location recorded');

  const scores = await db.query<{ rel: number; pri: number; policy: string }>(
    `SELECT relevance_score AS rel, priority_score AS pri, scoring_policy_version_id::text AS policy
     FROM lead_scores WHERE lead_id = $1 AND is_current`, [f.leadId],
  );
  assert.equal(scores.rowCount, 1);
  assert.ok(Number(scores.rows[0]?.rel) >= 0 && Number(scores.rows[0]?.rel) <= 100);
  assert.ok(Number(scores.rows[0]?.pri) > 0);
  const allScores = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM lead_scores WHERE lead_id = $1', [f.leadId],
  );
  assert.equal(allScores.rows[0]?.n, '1', 'exactly one score row for a first run');

  const runs = await db.query<{ status: string; provider: string }>(
    `SELECT r.status::text AS status, p.name AS provider FROM ai_runs r
     JOIN ai_providers p ON p.id = r.provider_id WHERE r.lead_id = $1`, [f.leadId],
  );
  assert.equal(runs.rowCount, 1);
  assert.equal(runs.rows[0]?.status, 'SUCCESS');
  assert.equal(runs.rows[0]?.provider, 'fake:deterministic');

  const resolved = await policy.resolve(f.tenantId);
  assert.equal(resolved.version, 1);
  const biz = await db.query<{ bt: string | null }>('SELECT business_type_node_id::text AS bt FROM businesses WHERE tenant_id = $1 AND canonical_name = $2', [f.tenantId, 'چاپخانه تهران']);
  assert.equal(biz.rows[0]?.bt, f.wholesalerId, 'business model applied non-destructively');
});

test('duplicate execution never creates duplicate current analysis/score rows', async (t) => {
  if (!withDb(t) || db === null) return;
  const f = await seed(db);
  const { deps: flowDeps } = deps(db);
  const ctx = { tenantId: f.tenantId, jobId: f.jobId, correlationId: null };

  const first = await runAnalysisForLead(flowDeps, { leadId: f.leadId }, ctx);
  await assert.rejects(() => runAnalysisForLead(flowDeps, { leadId: f.leadId }, ctx), AnalysisSkipError);

  const counts = await db.query<{ a: string; s: string; e: string }>(
    `SELECT (SELECT count(*) FROM lead_analyses WHERE lead_id = $1)::text AS a,
            (SELECT count(*) FROM lead_scores WHERE lead_id = $1)::text AS s,
            (SELECT count(*) FROM evidence WHERE lead_id = $1)::text AS e`,
    [f.leadId],
  );
  assert.equal(counts.rows[0]?.a, '1');
  assert.equal(counts.rows[0]?.s, '1');
  assert.equal(first.analysisId, (await db.query<{ id: string }>('SELECT id FROM lead_analyses WHERE lead_id = $1', [f.leadId])).rows[0]?.id);
});

test('a new analysis version supersedes the old one; history stays auditable', async (t) => {
  if (!withDb(t) || db === null) return;
  const f = await seed(db);
  const { deps: flowDeps } = deps(db);
  const first = await runAnalysisForLead(flowDeps, { leadId: f.leadId }, {
    tenantId: f.tenantId, jobId: f.jobId, correlationId: null,
  });

  // REPROCESS back into ANALYSIS_PENDING for a second job (orchestrator path).
  const orchestrator = new DbOrchestrator({ db });
  await orchestrator.reprocess({ tenantId: f.tenantId, leadId: f.leadId, analysisMode: 'STANDARD' });
  const secondJob = randomUUID();
  await db.query(
    `INSERT INTO jobs (id, tenant_id, type, payload) VALUES ($1, $2, 'REPROCESS', $3)`,
    [secondJob, f.tenantId, JSON.stringify({ leadId: f.leadId, analysisMode: 'STANDARD', reason: 'reprocess' })],
  );
  const second = await runAnalysisForLead(flowDeps, { leadId: f.leadId }, {
    tenantId: f.tenantId, jobId: secondJob, correlationId: null,
  });

  assert.notEqual(first.analysisId, second.analysisId);
  const rows = await db.query<{ id: string; is_current: boolean; superseded_at: string | null }>(
    'SELECT id, is_current, superseded_at FROM lead_analyses WHERE lead_id = $1 ORDER BY created_at',
    [f.leadId],
  );
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows.filter((r) => r.is_current).length, 1);
  const old = rows.rows.find((r) => r.id === first.analysisId);
  assert.equal(old?.is_current, false);
  assert.notEqual(old?.superseded_at, null);

  const scores = await db.query<{ n: string; cur: string }>(
    `SELECT count(*)::text AS n, count(*) FILTER (WHERE is_current)::text AS cur
     FROM lead_scores WHERE lead_id = $1`, [f.leadId],
  );
  assert.equal(scores.rows[0]?.n, '2');
  assert.equal(scores.rows[0]?.cur, '1');
});

test('tenant isolation: foreign tenants see nothing and cannot transition', async (t) => {
  if (!withDb(t) || db === null) return;
  const f = await seed(db);
  const { deps: flowDeps } = deps(db);
  const store = new DbAnalysisStore(db);

  assert.equal(await store.loadContext(OTHER, f.leadId, 'STANDARD'), null);
  assert.equal(await store.loadContext(f.tenantId, f.leadId, 'STANDARD') !== null, true);

  const orchestrator = new DbOrchestrator({ db });
  await assert.rejects(
    () => orchestrator.applyLeadEvent({ leadId: f.leadId, tenantId: OTHER, event: 'ANALYSIS_STARTED', expectedFrom: 'ANALYSIS_PENDING', to: 'ANALYZING' }),
    TransitionError,
  );
  const status = await db.query<{ s: string }>('SELECT status::text AS s FROM leads WHERE id = $1', [f.leadId]);
  assert.equal(status.rows[0]?.s, 'ANALYSIS_PENDING');
  void flowDeps;
});

test('orchestrator owns transitions: illegal moves rejected, REPROCESS requeues', async (t) => {
  if (!withDb(t) || db === null) return;
  const f = await seed(db);
  const orchestrator = new DbOrchestrator({ db });

  await assert.rejects(
    () => orchestrator.applyLeadEvent({ leadId: f.leadId, tenantId: f.tenantId, event: 'ANALYSIS_SUCCEEDED', expectedFrom: 'ANALYSIS_PENDING', to: 'SCORED' }),
    TransitionError,
  );

  await db.query(`UPDATE jobs SET status = 'SUCCEEDED' WHERE id = $1`, [f.jobId]);
  await db.query(`UPDATE leads SET status = 'QUALIFIED' WHERE id = $1`, [f.leadId]);
  const job = await orchestrator.reprocess({ tenantId: f.tenantId, leadId: f.leadId, analysisMode: 'STANDARD' });
  assert.equal(job.type, 'REPROCESS');
  const status = await db.query<{ s: string }>('SELECT status::text AS s FROM leads WHERE id = $1', [f.leadId]);
  assert.equal(status.rows[0]?.s, 'ANALYSIS_PENDING');

  // Re-submitting while a job is active reuses it (no duplicate jobs).
  const again = await orchestrator.reprocess({ tenantId: f.tenantId, leadId: f.leadId, analysisMode: 'STANDARD' });
  assert.equal(again.id, job.id);
});
