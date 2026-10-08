/**
 * Phase 20.1 integration tests against REAL PostgreSQL (the migrated dev DB):
 * the dual match path (taxonomy OR content) in DbSearchExecutor.
 *
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:5432/ulip \
 *     node --experimental-strip-types --test packages/search/test/integration.search-db.test.ts
 *
 * Without a reachable, migrated database every test SKIPS with an explicit
 * reason — never silently passes. Covers the review cases:
 *   A — taxonomy match still works
 *   B — content-driven match (generic profile, relevant lead_contents)
 *   C — taxonomy + content ⇒ both flags and stronger deterministic ranking
 *   D — unrelated content is NOT matched by a broad/common term
 *   E — tenant isolation for content matching
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Database } from '@ulip/runtime';
import { DbSearchExecutor } from '../src/executor.ts';
import { rankRows } from '../src/ranker.ts';
import type { ExecutorFilters } from '../src/contracts.ts';

const url = process.env.ULIP_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/ulip';
let db: Database | null = null;
let skipReason = '';
const cleanup: string[] = [];

before(async () => {
  try {
    db = new Database({ connectionString: url, max: 4 });
    const probe = await db.query<{ present: boolean }>(`SELECT to_regclass('public.leads') IS NOT NULL AS present`);
    if (probe.rows[0]?.present !== true) {
      throw new Error('schema not migrated — run `pnpm migrate` first');
    }
  } catch (err) {
    db = null;
    skipReason = `PostgreSQL unavailable/unmigrated at ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`\n[SKIP] search-db integration: ${skipReason}\n`);
  }
});

after(async () => {
  if (db === null) return;
  for (const id of cleanup.reverse()) {
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  }
  await db.close().catch(() => undefined);
});

function withDb(t: { skip(reason: string): void }): DbSearchExecutor | null {
  if (db === null) {
    t.skip(skipReason);
    return null;
  }
  return new DbSearchExecutor(db);
}

function filters(overrides: Partial<ExecutorFilters> = {}): ExecutorFilters {
  return {
    businessTypeNodeIds: [],
    industryNodeIds: [],
    specialtyNodeIds: [],
    subSpecialtyNodeIds: [],
    brands: [],
    city: null,
    country: null,
    sourceType: null,
    status: null,
    minRelevance: null,
    minAudienceQuality: null,
    minActivity: null,
    minConfidence: null,
    contentTerms: [],
    ...overrides,
  };
}

interface SeededLead {
  tenantId: string;
  leadId: string;
  businessId: string;
}

async function seedTenant(): Promise<string> {
  const target = db as Database;
  const tenantId = randomUUID();
  cleanup.push(tenantId);
  await target.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `search-it-${tenantId.slice(0, 8)}`]);
  return tenantId;
}

/** Seeds business + lead under the given tenant; optional specialty classification, location and content rows. */
async function seedLead(tenantId: string, opts: {
  name: string;
  description?: string;
  specialtyNodeId?: string;
  city?: string;
  contents?: string[];
}): Promise<SeededLead> {
  const target = db as Database;
  const src = randomUUID();
  await target.query(`INSERT INTO sources (id, tenant_id, type, name) VALUES ($1, $2, 'FAKE', 'search-it-src')`, [src, tenantId]);
  const businessId = randomUUID();
  await target.query(
    `INSERT INTO businesses (id, tenant_id, canonical_name, description) VALUES ($1, $2, $3, $4)`,
    [businessId, tenantId, opts.name, opts.description ?? null],
  );
  const leadId = randomUUID();
  await target.query(`INSERT INTO leads (id, tenant_id, business_id) VALUES ($1, $2, $3)`, [leadId, tenantId, businessId]);
  if (opts.specialtyNodeId !== undefined) {
    await target.query(
      `INSERT INTO lead_classifications (lead_id, classification_type, taxonomy_node_id, value_text, source)
       VALUES ($1, 'SPECIALTY', $2, $3, 'RULE')`,
      [leadId, opts.specialtyNodeId, opts.name],
    );
  }
  if (opts.city !== undefined) {
    await target.query(
      `INSERT INTO business_locations (business_id, country, city, raw_value) VALUES ($1, 'Iran', $2, $2)`,
      [businessId, opts.city],
    );
  }
  let i = 0;
  for (const text of opts.contents ?? []) {
    i += 1;
    await target.query(
      `INSERT INTO lead_contents (lead_id, source_id, source_content_id, content_type, text, content_hash, retrieved_at)
       VALUES ($1, $2, $3, 'POST', $4, $5, now())`,
      [leadId, src, `sc-${leadId.slice(0, 8)}-${i}`, text, `${leadId}-${i}`],
    );
  }
  return { tenantId, leadId, businessId };
}

async function seedSpecialtyNode(tenantId: string): Promise<string> {
  const target = db as Database;
  // Schema hierarchy: BUSINESS_TYPE → INDUSTRY → SPECIALTY (parent kind enforced).
  const btId = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, NULL, 'BUSINESS_TYPE', 'Wholesaler', $3)`,
    [btId, tenantId, `wholesaler-${btId.slice(0, 8)}`],
  );
  const indId = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, $3, 'INDUSTRY', 'Printing', $4)`,
    [indId, tenantId, btId, `printing-${indId.slice(0, 8)}`],
  );
  const id = randomUUID();
  await target.query(
    `INSERT INTO taxonomy_nodes (id, tenant_id, parent_id, node_kind, name, slug)
     VALUES ($1, $2, $3, 'SPECIALTY', 'قطعات پرینتر', $4)`,
    [id, tenantId, indId, `printer-parts-${id.slice(0, 8)}`],
  );
  return id;
}

test('Case A — taxonomy match: classified business still matches (taxonomy OR content)', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  const tenantId = await seedTenant();
  const nodeId = await seedSpecialtyNode(tenantId);
  const a = await seedLead(tenantId, { name: 'A Classified Shop', specialtyNodeId: nodeId, contents: ['سلام'] });
  const res = await executor.search(
    a.tenantId,
    filters({ specialtyNodeIds: [nodeId], contentTerms: ['قطعات پرینتر'] }),
    { page: 1, limit: 50 },
    [],
  );
  assert.equal(res.total, 1);
  const row = res.rows.find((r) => r.id === a.leadId);
  assert.ok(row, 'classified business must match');
  assert.equal(row.matched.specialty, true);
});

test('Case B — content-driven match: generic profile but relevant lead_contents matches', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  const tenantId = await seedTenant();
  const nodeId = await seedSpecialtyNode(tenantId);
  const b = await seedLead(tenantId, {
    name: 'B Generic Shop',
    contents: ['فروش انواع قطعات پرینتر HP با گارانتی', 'لیزر و جوهر افکن موجود است'],
  });
  // Structured taxonomy filter present (the term resolved) — the business has
  // NO classification, so ONLY the content OR-path can admit it.
  const res = await executor.search(
    b.tenantId,
    filters({ specialtyNodeIds: [nodeId], contentTerms: ['قطعات پرینتر'] }),
    { page: 1, limit: 50 },
    [],
  );
  const row = res.rows.find((r) => r.id === b.leadId);
  assert.ok(row, 'business with relevant content must match through the content OR-path');
  assert.equal(row.matched.specialty, false);
  assert.equal(row.matched.content, true);
  assert.ok(row.contentMatches.length > 0, 'matched content snippets must be attached');
});

test('Case C — taxonomy + content: both flags set, stronger deterministic ranking', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  const tenantId = await seedTenant();
  const nodeId = await seedSpecialtyNode(tenantId);
  const c = await seedLead(tenantId, {
    name: 'C Both Shop',
    specialtyNodeId: nodeId,
    contents: ['تعمیر و فروش قطعات پرینتر HP'],
  });
  const res = await executor.search(
    c.tenantId,
    filters({ specialtyNodeIds: [nodeId], contentTerms: ['قطعات پرینتر'] }),
    { page: 1, limit: 50 },
    [],
  );
  const row = res.rows.find((r) => r.id === c.leadId);
  assert.ok(row);
  assert.equal(row.matched.specialty, true);
  assert.equal(row.matched.content, true);
  const ranked = rankRows(res.rows, true);
  const reasons = ranked[0]?.reasons.map((r) => r.type) ?? [];
  assert.ok(reasons.includes('SPECIALTY_MATCH'), 'taxonomy reason present');
  assert.ok(reasons.includes('CONTENT_RELEVANCE'), 'content reason present');
  const expected = 50 + 10 + 6; // neutral baseline + specialty + content
  assert.equal(ranked[0]?.searchScore, expected);
});

test('Case D — unrelated content: a broad/common term elsewhere must NOT admit the lead', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  const tenantId = await seedTenant();
  const nodeId = await seedSpecialtyNode(tenantId);
  const d = await seedLead(tenantId, { name: 'D Unrelated Shop', contents: ['فروش کیف و کفش وارداتی'] });
  const res = await executor.search(
    d.tenantId,
    filters({ specialtyNodeIds: [nodeId], contentTerms: ['قطعات پرینتر'] }),
    { page: 1, limit: 50 },
    [],
  );
  assert.equal(res.rows.find((r) => r.id === d.leadId), undefined, 'unrelated content must not match the content OR-path');
});

test('Case E — tenant isolation: identical content in another tenant is invisible', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  const tenant1 = await seedTenant();
  const nodeId = await seedSpecialtyNode(tenant1);
  const t1 = await seedLead(tenant1, { name: 'E T1 Shop', contents: ['فروش قطعات پرینتر HP'] });
  const tenant2 = await seedTenant();
  const t2 = await seedLead(tenant2, { name: 'E T2 Shop', contents: ['فروش قطعات پرینتر HP'] });
  const res = await executor.search(
    t1.tenantId,
    filters({ specialtyNodeIds: [nodeId], contentTerms: ['قطعات پرینتر'] }),
    { page: 1, limit: 50 },
    [],
  );
  const ids = res.rows.map((r) => r.id);
  assert.ok(ids.includes(t1.leadId), 'own-tenant content match visible');
  assert.ok(!ids.includes(t2.leadId), 'other-tenant lead must never appear');
});

test('Case D2 — content-only query (no taxonomy filters) keeps AND semantics with hard filters', async (t) => {
  const executor = withDb(t);
  if (executor === null) return;
  // With NO structured filters at all, content terms must not match a lead
  // that lacks the content either (no broad uncontrolled scans).
  const tenantId = await seedTenant();
  const d = await seedLead(tenantId, { name: 'D2 Empty Shop' });
  const res = await executor.search(d.tenantId, filters({ contentTerms: ['قطعات پرینتر'] }), { page: 1, limit: 50 }, []);
  assert.equal(res.rows.find((r) => r.id === d.leadId), undefined);
});
