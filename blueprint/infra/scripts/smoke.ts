/**
 * End-to-end smoke flow (Phase 14). Requires a REAL running stack:
 *   docker compose -f infra/docker/docker-compose.runtime.yml up --build
 *
 * Flow: health → bootstrap tenant+api key → source → taxonomy → lead →
 * campaign → persistent job → worker processes → API reports SUCCEEDED.
 *
 * Note: this script verifies the API↔DB path directly and enqueues to Redis;
 * when a worker is running it processes the job and the final GET reports
 * SUCCEEDED. Exits 0 only when the whole chain is green.
 */

import { createHash } from 'node:crypto';
import { loadEnv } from '@ulip/runtime';

const env = loadEnv();
const BASE = `http://localhost:${env.APP_PORT}`;
const TENANT_EMAIL = `smoke-${Date.now()}@ulip.test`;
const API_KEY = `smoke-key-${Date.now()}-${createHash('sha256').update(TENANT_EMAIL).digest('hex').slice(0, 24)}`;

async function api(path: string, init: RequestInit & { key?: string } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.key !== undefined ? { authorization: `Bearer ${init.key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body };
}

function fail(step: string, detail: unknown): never {
  console.error(`✖ ${step}`, detail);
  process.exit(1);
}

// 1. health
{
  const { status, body } = await api('/health');
  if (status !== 200 || body.status !== 'UP') fail('health', { status, body });
  console.log('✔ health OK');
}

// 2. bootstrap: create tenant + user with api key (bootstrap token = BOOTSTRAP_API_KEY)
let key: string;
{
  const { status, body } = await api('/internal/bootstrap', {
    method: 'POST',
    key: env.BOOTSTRAP_API_KEY,
    body: JSON.stringify({ tenantName: 'Smoke Tenant', userEmail: TENANT_EMAIL, apiKey: API_KEY }),
  });
  if (status !== 201) fail('bootstrap', { status, body });
  key = body.apiKey ?? API_KEY;
  console.log('✔ tenant + api key ready');
}

// 3. source (FAKE = deterministic E2E provider; production types require real credentials)
let sourceId: string;
{
  const { status, body } = await api('/sources', { method: 'POST', key, body: JSON.stringify({ type: 'FAKE', name: 'smoke-src', config: {} }) });
  if (status !== 201) fail('create source', { status, body });
  sourceId = body.id;
  console.log('✔ source created', sourceId);
}

// 4. taxonomy node (root BUSINESS_TYPE)
let taxonomyId: string;
{
  const { status, body } = await api('/taxonomy', {
    method: 'POST',
    key,
    body: JSON.stringify({ nodeKind: 'BUSINESS_TYPE', name: 'Wholesaler', slug: `wholesaler-${Date.now()}` }),
  });
  if (status !== 201) fail('create taxonomy', { status, body });
  taxonomyId = body.id;
  console.log('✔ taxonomy node created', taxonomyId);
}

// 5. lead
let leadId: string;
{
  const { status, body } = await api('/leads', {
    method: 'POST',
    key,
    body: JSON.stringify({
      businessName: 'چاپخانه تهران',
      sourceId,
      externalId: `smoke-${Date.now()}`,
      businessTypeId: taxonomyId,
    }),
  });
  if (status !== 201) fail('create lead', { status, body });
  leadId = body.id;
  console.log('✔ lead created', leadId);
}

// 6. campaign
{
  const { status, body } = await api('/campaigns', {
    method: 'POST',
    key,
    body: JSON.stringify({ name: 'Smoke Campaign', filters: { businessTypes: [taxonomyId] } }),
  });
  if (status !== 201) fail('create campaign', { status, body });
  console.log('✔ campaign created', body.id);
}

// 7. persistent job — REAL discovery pipeline (Phase 15): connector → raw →
// normalize → dedup/ER → lead. allowFake opts into the deterministic E2E
// provider explicitly; production source types never use it.
let jobId: string;
{
  const { status, body } = await api('/jobs', {
    method: 'POST',
    key,
    body: JSON.stringify({ type: 'DISCOVERY', payload: { sourceId, allowFake: true, maxCandidates: 10 } }),
  });
  if (status !== 202) fail('create job', { status, body });
  jobId = body.id;
  console.log('✔ persistent discovery job created', jobId);
}

// 8. wait for worker completion (DB is truth; API reports it)
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const { status, body } = await api(`/jobs/${jobId}`, { key });
  if (status !== 200) fail('get job', { status, body });
  if (body.status === 'SUCCEEDED') {
    console.log('✔ worker processed job → API reports SUCCEEDED');
    console.log('\nSMOKE OK — full chain green');
    process.exit(0);
  }
  if (body.status === 'FAILED') fail('job failed', body);
  await new Promise((r) => setTimeout(r, 1000));
}
fail('job did not complete within 60s', { jobId });
