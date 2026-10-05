/**
 * Database constraint tests (remediation §39).
 *
 * These run against a REAL PostgreSQL when available:
 *   docker run -d --name ulip-pg-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ulip -p 55432:5432 postgres:16
 *   npm i -g pg  (or install locally) then:
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:55432/ulip node --experimental-strip-types --test database/tests/db-constraints.test.ts
 *
 * When PostgreSQL is unavailable each test SKIPS with an explicit reason —
 * the suite never silently passes, and CI must run it on a Docker-capable runner.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = join(ROOT, 'database', 'schema', 'schema.sql');
const DOWN = join(ROOT, 'database', 'migrations', '0001_initial_core', 'down.sql');

const url = process.env.ULIP_PG_URL ?? 'postgresql://postgres:postgres@localhost:55432/ulip';

let Client: any;
let client: any;
let available = false;
let skipReason = '';

before(async () => {
  try {
    const mod: any = await import('pg');
    Client = mod.Client ?? mod.default?.Client;
    client = new Client({ connectionString: url });
    await client.connect();
    available = true;
  } catch (err) {
    skipReason =
      'PostgreSQL unavailable. Start: docker run -d --name ulip-pg-test ' +
      '-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ulip -p 55432:5432 postgres:16 ' +
      'Reason: ' +
      (err instanceof Error ? err.message : String(err));
    console.warn(`\n[SKIP] db-constraints: ${skipReason}\n`);
  }
});

after(async () => {
  if (available) {
    try {
      await client.query(readFileSync(DOWN, 'utf8'));
    } catch {
      /* teardown best-effort */
    }
    await client.end();
  }
});

function withDb(t: any): boolean {
  if (!available) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

async function applySchema() {
  await client.query(readFileSync(SCHEMA, 'utf8'));
}

const T1 = '10000000-0000-0000-0000-0000000aa001';
const T2 = '10000000-0000-0000-0000-0000000aa002';
const T3 = '10000000-0000-0000-0000-0000000aa003';
const T4 = '10000000-0000-0000-0000-0000000aa004';
const T5 = '10000000-0000-0000-0000-0000000aa005';
const T6 = '10000000-0000-0000-0000-0000000aa006';
const T7 = '10000000-0000-0000-0000-0000000aa007';

test('schema applies cleanly (all constraints parse)', async (t) => {
  if (!withDb(t)) return;
  await applySchema();
  const r = await client.query(
    `SELECT count(*)::int AS n FROM pg_type WHERE typtype = 'e' AND typname = 'lead_status'`,
  );
  assert.equal(r.rows[0].n, 1);
});

test('taxonomy root uniqueness: duplicate root slugs rejected by partial index', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T1}', 'T1')`);
  const ins = (slug: string) =>
    client.query(
      `INSERT INTO taxonomy_nodes (tenant_id, parent_id, node_kind, name, slug)
       VALUES ('${T1}', NULL, 'BUSINESS_TYPE', $1, $2)`,
      [slug, slug],
    );
  await ins('retailer');
  await assert.rejects(() => ins('retailer'), /uniq_taxonomy_root_slug/);
});

test('taxonomy child uniqueness: same slug under different parents allowed, duplicate under same parent rejected', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T2}', 'T2')`);
  const rootA = '20000000-0000-0000-0000-0000000bb001';
  const rootB = '20000000-0000-0000-0000-0000000bb002';
  for (const [id, slug] of [
    [rootA, 'service-provider'],
    [rootB, 'wholesaler'],
  ] as const) {
    await client.query(
      `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
       VALUES ('${id}', '${T2}', NULL, 'BUSINESS_TYPE', $1, $1)`,
      [slug],
    );
  }
  const insIndustry = (parent: string) =>
    client.query(
      `INSERT INTO taxonomy_nodes (tenant_id, parent_id, node_kind, name, slug)
       VALUES ('${T2}', '${parent}', 'INDUSTRY', 'Beauty', 'beauty')`,
    );
  await insIndustry(rootA);
  await insIndustry(rootB); // different parents → allowed
  await assert.rejects(() => insIndustry(rootA), /uniq_taxonomy/); // same parent → rejected
});

test('taxonomy hierarchy trigger rejects SPECIALTY under BUSINESS_TYPE', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T3}', 'T3')`);
  const bt = '20000000-0000-0000-0000-0000000bb003';
  await client.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ('${bt}', '${T3}', NULL, 'BUSINESS_TYPE', 'Retailer', 'retailer')`,
  );
  await assert.rejects(
    () =>
      client.query(
        `INSERT INTO taxonomy_nodes (tenant_id, parent_id, node_kind, name, slug)
         VALUES ('${T3}', '${bt}', 'SPECIALTY', 'Printer Parts', 'printer-parts')`,
      ),
    /parent kind mismatch/,
  );
});

test('raw_entities: identical payload collapses across collection times; changed payload snapshots', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T4}', 'T4')`);
  const src = '30000000-0000-0000-0000-0000000cc001';
  await client.query(
    `INSERT INTO sources (id, tenant_id, type, name) VALUES ('${src}', '${T4}', 'INSTAGRAM', 'ig')`,
  );
  // Collapse semantics: ingest sites use ON CONFLICT DO NOTHING so a re-collection
  // of an identical payload is a no-op, while a changed payload (new content_hash)
  // creates a new snapshot. The DB constraint uniq_raw_identity_content enforces it.
  const ins = (hash: string, collectedAt: string) =>
    client.query(
      `INSERT INTO raw_entities (source_id, external_id, entity_type, payload_json, content_hash, collected_at)
       VALUES ('${src}', 'ext-1', 'PROFILE', '{}', $1, $2)
       ON CONFLICT (source_id, external_id, content_hash) DO NOTHING`,
      [hash, collectedAt],
    );
  await ins('hash-a', '2026-01-01T00:00:00Z');
  await ins('hash-a', '2026-01-02T00:00:00Z'); // same payload, later collection → collapse
  await ins('hash-b', '2026-01-02T00:00:00Z'); // changed payload → new snapshot
  const r = await client.query(
    `SELECT count(*)::int AS n FROM raw_entities WHERE source_id='${src}' AND external_id='ext-1'`,
  );
  assert.equal(r.rows[0].n, 2);
});

test('current analysis semantics: exactly one is_current row per lead', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T5}', 'T5')`);
  const biz = '40000000-0000-0000-0000-0000000dd001';
  await client.query(
    `INSERT INTO businesses (id, tenant_id, canonical_name) VALUES ('${biz}', '${T5}', 'Example')`,
  );
  const lead = '50000000-0000-0000-0000-0000000ee001';
  await client.query(
    `INSERT INTO leads (id, tenant_id, business_id) VALUES ('${lead}', '${T5}', '${biz}')`,
  );
  const insAnalysis = (version: string, current: boolean) =>
    client.query(
      `INSERT INTO lead_analyses (lead_id, analysis_version, structured_output, is_current, superseded_at)
       VALUES ('${lead}', $1, '{}', $2, CASE WHEN $2 THEN NULL ELSE now() END)`,
      [version, current],
    );
  await insAnalysis('v1', true);
  await assert.rejects(() => insAnalysis('v2', true), /uniq_leads_analysis_current/);
  await client.query(
    `UPDATE lead_analyses SET is_current = FALSE, superseded_at = now() WHERE lead_id='${lead}'`,
  );
  await insAnalysis('v2', true); // retirement then new current is valid
});

test('lead status is enum-enforced (no free-form lifecycle values)', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T6}', 'T6')`);
  const biz = '40000000-0000-0000-0000-0000000dd002';
  await client.query(
    `INSERT INTO businesses (id, tenant_id, canonical_name) VALUES ('${biz}', '${T6}', 'X')`,
  );
  await assert.rejects(
    () =>
      client.query(
        `INSERT INTO leads (tenant_id, business_id, status) VALUES ('${T6}', '${biz}', 'SOME_FREEFORM')`,
      ),
    /invalid input value for enum/,
  );
});

test('idempotency_keys unique scope is tenant+scope+key', async (t) => {
  if (!withDb(t)) return;
  await client.query(`INSERT INTO tenants (id, name) VALUES ('${T7}', 'T7')`);
  const ins = (scope: string, key: string) =>
    client.query(
      `INSERT INTO idempotency_keys (tenant_id, scope, idempotency_key, request_hash, expires_at)
       VALUES ('${T7}', $1, $2, 'h', now() + interval '24 hours')`,
      [scope, key],
    );
  await ins('POST /discovery/search', 'abc');
  await ins('POST /exports', 'abc'); // different scope → allowed
  await assert.rejects(() => ins('POST /discovery/search', 'abc'), /idempotency_keys/);
});
