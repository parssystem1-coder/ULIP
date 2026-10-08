/**
 * Phase 20 integration tests: Natural Language Search over the REAL stack
 * (PostgreSQL + Redis + API). Runs against the local runtime:
 *
 *   set -a; source infra/env/smoke.env; set +a
 *   ULIP_API_URL=http://localhost:3001 \
 *     node --experimental-strip-types --test apps/api/test/integration.search.test.ts
 *
 * Without a reachable API every test SKIPS with an explicit reason —
 * never silently passes. Covers:
 *  - Persian-first NL parsing through the working engine (parser honesty)
 *  - structured lead filtering through the SAME engine
 *  - SQL-injection payloads never break execution (parameterized SQL only)
 *  - tenant isolation for search results
 *  - discovery idempotency mismatch returns 409 (preflight fix)
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

const EMAIL = `search-it-${Date.now()}@ulip.test`;
const API_KEY = `search-key-${Date.now()}-abcdefghijklmnop`;

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
    console.warn(`\n[SKIP] search integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  if (BOOTSTRAP_KEY === '') {
    available = false;
    skipReason = 'BOOTSTRAP_API_KEY not set (see infra/env/smoke.env)';
    console.warn(`\n[SKIP] search integration: ${skipReason}\n`);
    t.skip(skipReason);
    return;
  }
  const res = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Search IT', userEmail: EMAIL, apiKey: API_KEY }),
  });
  assert.equal(res.status, 201);
  key = API_KEY;
});

test('NL search: Persian query parses + executes honestly (parser named in response)', async (t) => {
  if (!available) return t.skip(skipReason);

  const res = await authed('/leads/search/natural-language', {
    method: 'POST',
    key,
    body: JSON.stringify({ text: 'عمده‌فروشان قطعات پرینتر HP در تهران', limit: 10 }),
  });
  assert.equal(res.status, 200);
  const body = res.body;
  assert.equal(typeof body.query, 'string');
  assert.ok(['fa', 'en', 'mixed'].includes(body.locale), `unexpected locale ${body.locale}`);
  // Parser honesty: LLM when READY, deterministic rules otherwise — never silent.
  assert.ok(['LLM', 'RULES_FALLBACK'].includes(body.parser?.kind));
  assert.equal(typeof body.parser?.provider, 'string');
  assert.equal(typeof body.parser?.confidence, 'number');
  // Structured query must be the typed filter surface (no SQL, no raw expressions).
  assert.equal(typeof body.structuredQuery?.filters, 'object');
  assert.ok(typeof body.structuredQuery?.pagination?.limit === 'number');
  // Execution + ranked data always present with reasons.
  assert.equal(body.execution?.mode, 'EXISTING_ONLY');
  assert.ok(Array.isArray(body.data));
  for (const lead of body.data) {
    assert.equal(typeof lead.searchScore, 'number');
    assert.ok(Array.isArray(lead.reasons) && lead.reasons.length > 0);
  }
  assert.ok(typeof body.pagination?.total === 'number');
  assert.ok(typeof body.pagination?.totalPages === 'number');
  // Discovery plan present and honest.
  assert.ok(Array.isArray(body.execution?.discoveryPlan?.steps));
  // Empty text must be a 400, never a silent empty search.
  const empty = await authed('/leads/search/natural-language', { method: 'POST', key, body: JSON.stringify({ text: '   ' }) });
  assert.equal(empty.status, 400);
});

test('structured GET /leads uses the same engine (filters + pagination)', async (t) => {
  if (!available) return t.skip(skipReason);

  const res = await authed('/leads?page=1&limit=5&status=ANALYSIS_PENDING', { key });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.pagination?.page, 1);
  assert.equal(res.body.pagination?.limit, 5);
  assert.ok(typeof res.body.pagination?.total === 'number');

  const sorted = await authed('/leads?sort=createdAt&order=ASC&limit=3', { key });
  assert.equal(sorted.status, 200);
  assert.equal(sorted.body.pagination?.limit, 3);

  const badSort = await authed('/leads?sort=;DROP TABLE leads;--', { key });
  assert.equal(badSort.status, 200, 'unknown sort values must be ignored, never executed');
});

test('SQL injection payloads never alter execution (parameterized SQL only)', async (t) => {
  if (!available) return t.skip(skipReason);

  const payloads = [
    "'; DROP TABLE leads; --",
    "' OR '1'='1",
    'HP%--',
    'تیهران\u0000; DELETE FROM leads',
    "أ' UNION SELECT * FROM users--",
  ];
  for (const p of payloads) {
    const nl = await authed('/leads/search/natural-language', {
      method: 'POST',
      key,
      body: JSON.stringify({ text: p, limit: 5 }),
    });
    assert.equal(nl.status, 200, `NL search must survive payload ${JSON.stringify(p)}`);
    assert.ok(Array.isArray(nl.body.data));
    const structured = await authed(`/leads?city=${encodeURIComponent(p)}&brand=${encodeURIComponent(p)}`, { key });
    assert.equal(structured.status, 200, `structured search must survive payload ${JSON.stringify(p)}`);
  }
  // The leads table must still exist and serve.
  const after = await authed('/leads', { key });
  assert.equal(after.status, 200);
});

test('tenant isolation: a second tenant sees no leads and no shared search results', async (t) => {
  if (!available) return t.skip(skipReason);

  const EMAIL2 = `search2-${Date.now()}@ulip.test`;
  const KEY2 = `search2-key-${Date.now()}-abcdefghijklmnop`;
  const boot2 = await fetch(`${BASE}/internal/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BOOTSTRAP_KEY}` },
    body: JSON.stringify({ tenantName: 'Search IT 2', userEmail: EMAIL2, apiKey: KEY2 }),
  });
  assert.equal(boot2.status, 201);

  const lead2 = await authed('/leads', { key: KEY2 });
  assert.equal(lead2.status, 200);
  assert.equal((lead2.body.data ?? []).length, 0, 'tenant 2 must see zero leads');

  const nl2 = await authed('/leads/search/natural-language', {
    method: 'POST',
    key: KEY2,
    body: JSON.stringify({ text: 'عمده‌فروش قطعات پرینتر HP در تهران', limit: 50 }),
  });
  assert.equal(nl2.status, 200);
  assert.equal((nl2.body.data ?? []).length, 0, 'tenant 2 NL search must not leak tenant 1 rows');

  // Discovery plan steps must be scoped to tenant 2's sources only.
  const tenantSources = await authed('/sources', { key: KEY2 });
  const plannedSourceIds = (nl2.body.execution?.discoveryPlan?.steps ?? []).map((s: any) => s.sourceId);
  for (const id of plannedSourceIds) {
    assert.ok((tenantSources.body.data ?? []).some((s: any) => s.id === id), 'plan leaked a foreign source');
  }
});

test('discovery idempotency mismatch: same key + different payload ⇒ 409 (preflight fix)', async (t) => {
  if (!available) return t.skip(skipReason);

  const src = await authed('/sources', {
    method: 'POST',
    key,
    body: JSON.stringify({ type: 'FAKE', name: 'search-it-fake-src', config: {} }),
  });
  assert.equal(src.status, 201);
  const sourceId: string = src.body.id;

  const idem = `search-it-fixed-${EMAIL}`;
  const a = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId, allowFake: true, maxCandidates: 5 }),
    headers: { 'idempotency-key': idem },
  });
  assert.equal(a.status, 202);

  const b = await authed('/discovery/search', {
    method: 'POST',
    key,
    body: JSON.stringify({ sourceId, allowFake: true, maxCandidates: 500 }),
    headers: { 'idempotency-key': idem },
  });
  assert.equal(b.status, 409, 'same idempotency key with a different payload must conflict');
  assert.equal(b.body.error?.code, 'IDEMPOTENCY_CONFLICT');
});
