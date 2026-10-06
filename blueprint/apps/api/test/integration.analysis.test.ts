/**
 * Phase 16 integration: DISCOVERY → LEAD → ANALYSIS_PENDING → (worker)
 * ANALYZING → AI ANALYSIS → EVIDENCE → SCORES → QUALIFIED/REVIEW/REJECTED.
 *
 * Real stack required (PostgreSQL + Redis + API + worker):
 *   set -a; source infra/env/smoke.env; set +a
 *   ULIP_API_URL=http://localhost:3001 ULIP_IT_WORKER=1 AI_PROVIDER=fake \
 *     node --experimental-strip-types --test apps/api/test/integration.analysis.test.ts
 *
 * Without a reachable API every test SKIPS with an explicit reason.
 * External AI credentials are NOT required: the worker runs the deterministic
 * fake provider (AI_PROVIDER=fake, dev only) — never a silent fake.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const BASE = process.env.ULIP_API_URL ?? 'http://localhost:3001';
const BOOTSTRAP_KEY = process.env.BOOTSTRAP_API_KEY ?? '';

let available = false;
let skipReason = '';
let key = '';
let leadId = '';
let analysisJobId = '';

const EMAIL = `analysis-it-${Date.now()}@ulip.test`;
const API_KEY = `analysis-key-${Date.now()}-abcdefghijklmnop`;

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function authed(path: string, init: RequestInit & { key?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.key !== undefined ? { authorization: `Bearer ${init.key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function waitForJob(jobId: string, apiKey: string, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await authed(`/jobs/${jobId}`, { key: apiKey });
    if (r.status === 200 && (r.body.status === 'SUCCEEDED' || r.body.status === 'FAILED' || r.body.status === 'SKIPPED')) {
      return r.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

test('setup: API reachable + tenant bootstrapped', async (t) => {
  available = await ping();
  if (!available) {
    skipReason = `API not reachable at ${BASE}. Start the runtime stack first.`;
    console.warn(`\n[SKIP] analysis integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  if (BOOTSTRAP_KEY === '') {
    available = false;
    skipReason = 'BOOTSTRAP_API_KEY not set (see infra/env/smoke.env)';
    console.warn(`\n[SKIP] analysis integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  const res = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Analysis IT', userEmail: EMAIL, apiKey: API_KEY }),
  });
  assert.equal(res.status, 201);
  key = API_KEY;
});

test('E2E: discovery produces ANALYSIS_PENDING leads', async (t) => {
  if (!available) return t.skip(skipReason);
  if (process.env.ULIP_IT_WORKER !== '1') return t.skip('worker not running (set ULIP_IT_WORKER=1)');

  const src = await authed('/sources', {
    method: 'POST', key,
    body: JSON.stringify({ type: 'FAKE', name: 'analysis-src', config: {} }),
  });
  assert.equal(src.status, 201);

  const submit = await authed('/discovery/search', {
    method: 'POST', key,
    body: JSON.stringify({ sourceId: src.body.id, allowFake: true, maxCandidates: 10, query: '' }),
    headers: { 'idempotency-key': `an-disc-${Date.now()}` },
  });
  assert.equal(submit.status, 202);
  const discoveryJob = await waitForJob(submit.body.id, key);
  assert.equal(discoveryJob.status, 'SUCCEEDED');

  const leads = await authed('/leads?status=ANALYSIS_PENDING', { key });
  assert.equal(leads.status, 200);
  assert.ok(leads.body.data.length >= 1, 'expected ANALYSIS_PENDING leads');
  leadId = leads.body.data[0].id;
});

test('E2E: reprocess triggers analysis; worker runs AI → scores → terminal state', async (t) => {
  if (!available) return t.skip(skipReason);
  if (process.env.ULIP_IT_WORKER !== '1') return t.skip('worker not running (set ULIP_IT_WORKER=1)');
  assert.ok(leadId !== '', 'discovery step must run first');

  const idem = `reprocess-${Date.now()}`;
  const first = await authed(`/leads/${leadId}/reprocess`, {
    method: 'POST', key, body: JSON.stringify({ mode: 'STANDARD' }),
    headers: { 'idempotency-key': idem },
  });
  assert.equal(first.status, 202);
  assert.ok(['ANALYSIS', 'REPROCESS'].includes(first.body.type));
  analysisJobId = first.body.id;

  // Same idempotency key ⇒ the same job, replayed.
  const replay = await authed(`/leads/${leadId}/reprocess`, {
    method: 'POST', key, body: JSON.stringify({ mode: 'STANDARD' }),
    headers: { 'idempotency-key': idem },
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.id, analysisJobId);

  const job = await waitForJob(analysisJobId, key);
  assert.equal(job.status, 'SUCCEEDED', `analysis job failed: ${job.errorCode} ${job.errorMessage}`);

  const lead = await authed(`/leads/${leadId}`, { key });
  assert.equal(lead.status, 200);
  assert.ok(
    ['QUALIFIED', 'REVIEW_REQUIRED', 'REJECTED'].includes(lead.body.status),
    `expected terminal state, got ${lead.body.status}`,
  );

  const analysis = await authed(`/leads/${leadId}/analysis`, { key });
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.isCurrent, true);
  assert.ok(analysis.body.analysisVersion.includes(analysisJobId.slice(0, 8)));
  assert.ok(analysis.body.universal.businessType.available === true, 'business type detected');
  assert.equal(typeof analysis.body.universal.city.value, 'string');
  assert.ok(Array.isArray(analysis.body.explanation.reasons));
  assert.ok(analysis.body.explanation.reasons.length > 0, 'structured reasons exposed');
  assert.equal(analysis.body.explanation.meta.provider, 'fake:deterministic');

  const scores = await authed(`/leads/${leadId}/scores`, { key });
  assert.equal(scores.status, 200);
  for (const dim of ['relevance', 'audienceQuality', 'activity', 'confidence', 'priority']) {
    assert.equal(typeof scores.body[dim], 'number', `${dim} must be persisted`);
    assert.ok(scores.body[dim] >= 0 && scores.body[dim] <= 100);
  }
  assert.ok(typeof scores.body.scoringPolicyVersion === 'string');
  assert.equal(scores.body.reviewOutcome, lead.body.status);

  const evidence = await authed(`/leads/${leadId}/evidence`, { key });
  assert.equal(evidence.status, 200);
  assert.ok(evidence.body.data.length >= 3, 'evidence persisted');
  for (const e of evidence.body.data) {
    assert.ok(e.sourceReference.length > 0, 'provenance required');
    assert.equal(e.contentHash.length, 64);
    assert.notEqual(e.analysisId, null, 'evidence linked to its analysis');
  }
});

test('E2E: a second run creates a NEW analysis version (history is preserved)', async (t) => {
  if (!available) return t.skip(skipReason);
  if (process.env.ULIP_IT_WORKER !== '1') return t.skip('worker not running');
  assert.ok(analysisJobId !== '');

  const before = await authed(`/leads/${leadId}/analysis`, { key });
  const beforeId = before.body.id;

  const second = await authed(`/leads/${leadId}/reprocess`, {
    method: 'POST', key, body: JSON.stringify({ mode: 'STANDARD' }),
    headers: { 'idempotency-key': `reprocess2-${Date.now()}` },
  });
  assert.equal(second.status, 202);
  const job = await waitForJob(second.body.id, key);
  assert.equal(job.status, 'SUCCEEDED');

  const after = await authed(`/leads/${leadId}/analysis`, { key });
  assert.equal(after.status, 200);
  assert.notEqual(after.body.id, beforeId, 'new current analysis, old one superseded');
  assert.equal(after.body.isCurrent, true);
  assert.equal(after.body.supersededAt, null);
});

test('tenant isolation + auth boundary on analysis endpoints', async (t) => {
  if (!available) return t.skip(skipReason);
  assert.ok(leadId !== '');

  // Unauthenticated access is rejected everywhere.
  for (const path of [`/leads/${leadId}`, `/leads/${leadId}/analysis`, `/leads/${leadId}/scores`, `/leads/${leadId}/evidence`]) {
    const anon = await authed(path);
    assert.equal(anon.status, 401, `${path} must require auth`);
  }

  // A second tenant sees none of it.
  const KEY2 = `analysis2-key-${Date.now()}-abcdefghijklmnop`;
  const boot = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Analysis IT 2', userEmail: `analysis2-${Date.now()}@ulip.test`, apiKey: KEY2 }),
  });
  assert.equal(boot.status, 201);

  assert.equal((await authed(`/leads/${leadId}`, { key: KEY2 })).status, 404);
  assert.equal((await authed(`/leads/${leadId}/analysis`, { key: KEY2 })).status, 404);
  assert.equal((await authed(`/leads/${leadId}/scores`, { key: KEY2 })).status, 404);
  assert.equal((await authed(`/leads/${leadId}/evidence`, { key: KEY2 })).status, 404);
  const foreign = await authed(`/leads/${leadId}/reprocess`, {
    method: 'POST', key: KEY2, body: JSON.stringify({}),
    headers: { 'idempotency-key': `foreign-${Date.now()}` },
  });
  assert.equal(foreign.status, 404);

  // Unknown lead id → 404 (not 500).
  assert.equal((await authed('/leads/00000000-0000-0000-0000-0000000000aa/analysis', { key })).status, 404);
  assert.equal((await authed('/leads/not-a-uuid/scores', { key })).status, 404);
});
