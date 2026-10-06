/**
 * Phase 14 integration tests: API ↔ PostgreSQL ↔ Redis ↔ Worker.
 *
 * These run against a REAL stack when available:
 *   docker compose -f infra/docker/docker-compose.runtime.yml up -d postgres redis
 *   pnpm migrate && pnpm dev:api (background) then:
 *   ULIP_API_URL=http://localhost:3001 node --experimental-strip-types --test apps/api/test/integration.api.test.ts
 *
 * Without a reachable API + Postgres, every test SKIPS with an explicit
 * reason — never silently passes (per TESTING-STRATEGY).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const BASE = process.env.ULIP_API_URL ?? 'http://localhost:3001';
const BOOTSTRAP_KEY = process.env.BOOTSTRAP_API_KEY ?? '';
const EMAIL = `it-${Date.now()}@ulip.test`;
const API_KEY = `it-key-${Date.now()}-abcdefghijklmnop`;

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

test('setup: real API reachable', async (t) => {
  available = await ping();
  if (!available) {
    skipReason = `API not reachable at ${BASE}. Start the runtime stack: docker compose -f infra/docker/docker-compose.runtime.yml up --build`;
    console.warn(`\n[SKIP] api integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  if (BOOTSTRAP_KEY === '') {
    available = false;
    skipReason =
      'BOOTSTRAP_API_KEY not set. Run with the runtime env, e.g. ' +
      'set -a; source infra/env/smoke.env; set +a; ULIP_IT_WORKER=1 node --test apps/api/test/integration.api.test.ts';
    console.warn(`\n[SKIP] api integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  const res = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'IT Tenant', userEmail: EMAIL, apiKey: API_KEY }),
  });
  assert.equal(res.status, 201);
  key = API_KEY;
});

async function authed(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test('API ↔ PostgreSQL: health/ready + tenant-scoped source+lead+campaign roundtrip', async (t) => {
  if (!available) return t.skip(skipReason);
  const ready = await authed('/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.checks.postgres, true);

  const src = await authed('/sources', { method: 'POST', body: JSON.stringify({ type: 'INSTAGRAM', name: 'it-src' }) });
  assert.equal(src.status, 201);

  const tax = await authed('/taxonomy', {
    method: 'POST',
    body: JSON.stringify({ nodeKind: 'BUSINESS_TYPE', name: 'Wholesaler', slug: `it-bt-${Date.now()}` }),
  });
  assert.equal(tax.status, 201);

  const lead = await authed('/leads', {
    method: 'POST',
    body: JSON.stringify({ businessName: 'IT Biz', sourceId: src.body.id, externalId: `it-${Date.now()}` }),
  });
  assert.equal(lead.status, 201);

  const camp = await authed('/campaigns', { method: 'POST', body: JSON.stringify({ name: 'IT Campaign' }) });
  assert.equal(camp.status, 201);

  const list = await authed('/leads');
  assert.ok(list.body.data.some((l: { id: string }) => l.id === lead.body.id));
});

test('API ↔ Worker: persistent job completes via BullMQ + DB truth', async (t) => {
  if (!available) return t.skip(skipReason);
  if ((process.env.ULIP_IT_WORKER ?? '') !== '1') {
    t.skip('worker not running (set ULIP_IT_WORKER=1 with dev:worker up)');
    return;
  }
  const src = await authed('/sources', { method: 'POST', body: JSON.stringify({ type: 'FAKE', name: 'it-job-src' }) });
  assert.equal(src.status, 201);
  // A runnable source: the deterministic fake connector (explicit local E2E).
  // An unconfigured INSTAGRAM source intentionally fails NOT_CONFIGURED.
  const job = await authed('/jobs', {
    method: 'POST',
    body: JSON.stringify({ type: 'DISCOVERY', payload: { sourceId: src.body.id, allowFake: true, maxCandidates: 5 } }),
  });
  assert.equal(job.status, 202);

  const deadline = Date.now() + 60_000;
  let final: any = null;
  while (Date.now() < deadline) {
    const g = await authed(`/jobs/${job.body.id}`);
    final = g.body;
    if (g.body.status === 'SUCCEEDED' || g.body.status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(final?.status, 'SUCCEEDED');
});

test('tenant isolation: another tenant cannot read our jobs', async (t) => {
  if (!available) return t.skip(skipReason);
  const otherKey = `other-key-${Date.now()}-abcdefghijklmnop`;
  const other = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Other Tenant', userEmail: `other-${EMAIL}`, apiKey: otherKey }),
  });
  assert.equal(other.status, 201);

  const src = await authed('/sources', { method: 'POST', body: JSON.stringify({ type: 'INSTAGRAM', name: 'iso-src' }) });
  const job = await authed('/jobs', { method: 'POST', body: JSON.stringify({ type: 'DISCOVERY', payload: { sourceId: src.body.id } }) });

  const res = await fetch(`${BASE}/jobs/${job.body.id}`, {
    headers: { authorization: `Bearer ${otherKey}` },
  });
  assert.equal(res.status, 404); // not visible cross-tenant
});

test('auth boundary: missing/unknown key is 401', async (t) => {
  if (!available) return t.skip(skipReason);
  const noAuth = await fetch(`${BASE}/leads`);
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(`${BASE}/leads`, { headers: { authorization: 'Bearer wrong-key-value-here' } });
  assert.equal(badAuth.status, 401);
});
