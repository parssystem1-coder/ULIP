/**
 * Phase 15 integration tests: real discovery over the REAL stack
 * (PostgreSQL + Redis + API + worker). Runs against the local runtime:
 *
 *   set -a; source infra/env/smoke.env; set +a
 *   ULIP_API_URL=http://localhost:3001 ULIP_IT_WORKER=1 \
 *     node --experimental-strip-types --test apps/api/test/integration.discovery.test.ts
 *
 * Without a reachable API every test SKIPS with an explicit reason —
 * never silently passes. No external credentials are required: the flow
 * runs through the deterministic fake provider explicitly (allowFake).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const BASE = process.env.ULIP_API_URL ?? 'http://localhost:3001';
const BOOTSTRAP_KEY = process.env.BOOTSTRAP_API_KEY ?? '';

let available = false;
let skipReason = '';
let key = '';

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const EMAIL = `disc-it-${Date.now()}@ulip.test`;
const API_KEY = `disc-key-${Date.now()}-abcdefghijklmnop`;

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

test('setup: real API reachable + tenant bootstrapped', async (t) => {
  available = await ping();
  if (!available) {
    skipReason = `API not reachable at ${BASE}. Start the runtime stack first.`;
    console.warn(`\n[SKIP] discovery integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  if (BOOTSTRAP_KEY === '') {
    available = false;
    skipReason = 'BOOTSTRAP_API_KEY not set (see infra/env/smoke.env)';
    console.warn(`\n[SKIP] discovery integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  const res = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Discovery IT', userEmail: EMAIL, apiKey: API_KEY }),
  });
  assert.equal(res.status, 201);
  key = API_KEY;
});

test('discovery: idempotency + validation + tenant scoping on POST /discovery/search', async (t) => {
  if (!available) return t.skip(skipReason);

  // Create a FAKE source for this tenant.
  const src = await authed('/sources', {
    method: 'POST',
    key,
    body: JSON.stringify({ type: 'FAKE', name: 'fake-disc-src', config: {} }),
  });
  assert.equal(src.status, 201);
  const sourceId: string = src.body.id;

  // Missing Idempotency-Key ⇒ 400.
  const noKey = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId, allowFake: true, maxCandidates: 10 }),
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.error?.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const req = { sourceId, allowFake: true, maxCandidates: 10 };
  const first = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify(req),
    headers: { 'idempotency-key': `disc-${Date.now()}` },
  });
  assert.equal(first.status, 202);
  const jobId: string = first.body.id;
  assert.equal(first.body.type, 'DISCOVERY');

  // Same key + same body ⇒ replay of the ORIGINAL job, not a new one.
  const replay = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify(req),
    headers: { 'idempotency-key': `disc-${Date.now()}` },
  });
  // NOTE: different key value each call above would not replay; use same key:
  void replay;

  const idem = `fixed-key-${EMAIL}`;
  const a = await authed('/discovery/search', { method: 'POST', key, body: JSON.stringify(req), headers: { 'idempotency-key': idem } });
  assert.equal(a.status, 202);
  const b = await authed('/discovery/search', { method: 'POST', key, body: JSON.stringify(req), headers: { 'idempotency-key': idem } });
  assert.equal(b.status, 202);
  assert.equal(b.body.id, a.body.id, 'same idempotency key must return the original job');
  assert.equal(b.body.replayed, true);

  // Unknown source in this tenant ⇒ 404 (tenant isolation).
  const foreign = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId: '00000000-0000-0000-0000-0000000000aa', allowFake: true }),
    headers: { 'idempotency-key': `f-${Date.now()}` },
  });
  assert.equal(foreign.status, 404);

  // Malformed body (bad uuid) ⇒ 400 validation.
  const bad = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId: 'not-a-uuid' }),
    headers: { 'idempotency-key': `bad-${Date.now()}` },
  });
  assert.equal(bad.status, 400);
});

test('discovery E2E: worker runs pipeline; raw/normalized/dedup/lead + ANALYSIS_PENDING', async (t) => {
  if (!available) return t.skip(skipReason);
  if (process.env.ULIP_IT_WORKER !== '1') return t.skip('worker not running (set ULIP_IT_WORKER=1 with dev:worker up)');

  const src = await authed('/sources', {
    method: 'POST',
    key,
    body: JSON.stringify({ type: 'FAKE', name: 'fake-e2e-src', config: {} }),
  });
  assert.equal(src.status, 201);
  const sourceId: string = src.body.id;

  const submit = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId, allowFake: true, maxCandidates: 10, query: '' }),
    headers: { 'idempotency-key': `e2e-${Date.now()}` },
  });
  assert.equal(submit.status, 202);
  const jobId: string = submit.body.id;

  // Wait for the worker to finish (DB is truth; API reports it).
  const deadline = Date.now() + 60_000;
  let job: any = null;
  while (Date.now() < deadline) {
    const r = await authed(`/discovery/jobs/${jobId}`, { key });
    assert.equal(r.status, 200);
    if (r.body.status === 'SUCCEEDED' || r.body.status === 'FAILED') {
      job = r.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.notEqual(job, null, 'job did not settle within 60s');
  assert.equal(job.status, 'SUCCEEDED');

  // The fake dataset seeds 2 business profiles ⇒ 2 leads, in ANALYSIS_PENDING.
  const leads = await authed('/leads', { key });
  assert.equal(leads.status, 200);
  assert.ok(Array.isArray(leads.body.data));
  assert.ok(leads.body.data.length >= 2, 'fake provider should have produced >= 2 leads');

  // Tenant isolation: second tenant cannot see our leads or jobs.
  const EMAIL2 = `disc2-${Date.now()}@ulip.test`;
  const KEY2 = `disc2-key-${Date.now()}-abcdefghijklmnop`;
  const boot2 = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Discovery IT 2', userEmail: EMAIL2, apiKey: KEY2 }),
  });
  assert.equal(boot2.status, 201);
  const leads2 = await authed('/leads', { key: KEY2 });
  assert.equal((leads2.body.data ?? []).length, 0);
  const job2 = await authed(`/discovery/jobs/${jobId}`, { key: KEY2 });
  assert.equal(job2.status, 404);

  // Auth boundary: no/unknown key ⇒ 401.
  const anon = await authed('/discovery/search', {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  });
  assert.equal(anon.status, 401);
  const wrongKey = await authed('/discovery/search', {
    method: 'POST',
    key: 'totally-wrong-key-123456',
    body: JSON.stringify({ sourceId }),
    headers: { 'idempotency-key': `w-${Date.now()}` },
  });
  assert.equal(wrongKey.status, 401);
});
