/**
 * Phase 21 integration tests against REAL PostgreSQL:
 * DbHashtagBudgetStore — the persistent rolling-7-day hashtag budget.
 *
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:5433/ulip \
 *     node --experimental-strip-types --test packages/discovery/test/integration.hashtag-budget.test.ts
 *
 * Without a reachable, migrated database every test SKIPS with an explicit
 * reason — never silently passes.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Database } from '@ulip/runtime';
import { DbHashtagBudgetStore, normalizeHashtag } from '../src/hashtag-budget.ts';

const url = process.env.ULIP_PG_URL ?? 'postgresql://postgres:postgres@localhost:5432/ulip';
let db: Database | null = null;
let skipReason = '';
const cleanup: string[] = [];

before(async () => {
  try {
    db = new Database({ connectionString: url, max: 8 });
    const probe = await db.query<{ present: boolean }>(
      `SELECT to_regclass('public.hashtag_budget_ledger') IS NOT NULL AS present`,
    );
    if (probe.rows[0]?.present !== true) {
      throw new Error('migration 0006 not applied — run `pnpm migrate` first');
    }
  } catch (err) {
    db = null;
    skipReason = `PostgreSQL unavailable/unmigrated at ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`\n[SKIP] hashtag-budget integration: ${skipReason}\n`);
  }
});

after(async () => {
  if (db === null) return;
  for (const id of cleanup.reverse()) {
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  }
  await db.close().catch(() => undefined);
});

function withDb(t: { skip(reason: string): void }): DbHashtagBudgetStore | null {
  if (db === null) {
    t.skip(skipReason);
    return null;
  }
  return new DbHashtagBudgetStore(db);
}

async function seedTenantSource(): Promise<{ tenantId: string; sourceId: string }> {
  const target = db as Database;
  const tenantId = randomUUID();
  cleanup.push(tenantId);
  await target.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `hbl-it-${tenantId.slice(0, 8)}`]);
  const sourceId = randomUUID();
  await target.query(`INSERT INTO sources (id, tenant_id, type, name) VALUES ($1, $2, 'INSTAGRAM', 'hbl-src')`, [sourceId, tenantId]);
  return { tenantId, sourceId };
}

test('normalizeHashtag: ZWNJ/spacing variants collapse to one identity', () => {
  assert.equal(normalizeHashtag('وکیل خانواده'), normalizeHashtag('وکیل\u200cخانواده'));
  assert.equal(normalizeHashtag('#PrinterParts'), 'printerparts');
  assert.equal(normalizeHashtag('##tag__x '), 'tag_x');
});

test('budget: spend up to the cap, then refuse with typed reason', async (t) => {
  const store = withDb(t);
  if (store === null) return;
  const { tenantId, sourceId } = await seedTenantSource();
  for (let i = 0; i < 5; i++) {
    const r = await store.spend({ tenantId, sourceId, hashtag: `tag${i}`, budget: 5 });
    assert.equal(r.admitted, true, `spend ${i} must be admitted`);
    assert.equal(r.usedInWindow, i + 1);
  }
  const refused = await store.spend({ tenantId, sourceId, hashtag: 'tag6', budget: 5 });
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, 'HASHTAG_BUDGET_EXHAUSTED');
  const usage = await store.usage(tenantId, sourceId, 5);
  assert.deepEqual(usage, { used: 5, budget: 5, remaining: 0 });
});

test('budget: reuse of an in-window tag is free (Meta documented behavior)', async (t) => {
  const store = withDb(t);
  if (store === null) return;
  const { tenantId, sourceId } = await seedTenantSource();
  const first = await store.spend({ tenantId, sourceId, hashtag: 'وکیل_خانواده', budget: 2 });
  assert.equal(first.admitted, true);
  assert.equal(first.usedInWindow, 1);
  // Same tag, ZWNJ variant → same normalized identity → free reuse.
  const second = await store.spend({ tenantId, sourceId, hashtag: 'وکیل\u200cخانواده', budget: 2 });
  assert.equal(second.admitted, true);
  assert.equal(second.reused, true);
  assert.equal(second.usedInWindow, 1, 'reuse must not consume budget');
  // A different tag still fits under the cap.
  const third = await store.spend({ tenantId, sourceId, hashtag: 'وکیل', budget: 2 });
  assert.equal(third.admitted, true);
  assert.equal(third.usedInWindow, 2);
});

test('budget: tenant isolation — one tenant spending never blocks another', async (t) => {
  const store = withDb(t);
  if (store === null) return;
  const a = await seedTenantSource();
  const b = await seedTenantSource();
  for (let i = 0; i < 3; i++) {
    await store.spend({ tenantId: a.tenantId, sourceId: a.sourceId, hashtag: `iso${i}`, budget: 3 });
  }
  const refusedA = await store.spend({ tenantId: a.tenantId, sourceId: a.sourceId, hashtag: 'isoX', budget: 3 });
  assert.equal(refusedA.admitted, false);
  const bSpend = await store.spend({ tenantId: b.tenantId, sourceId: b.sourceId, hashtag: 'iso0', budget: 3 });
  assert.equal(bSpend.admitted, true, 'tenant B must be unaffected by tenant A spend');
});

test('budget: concurrent spenders can never exceed the cap (advisory lock)', async (t) => {
  const store = withDb(t);
  if (store === null) return;
  const { tenantId, sourceId } = await seedTenantSource();
  const CAP = 4;
  // 10 concurrent spends of distinct tags against a cap of 4 → exactly 4 admitted.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.spend({ tenantId, sourceId, hashtag: `conc${i}`, budget: CAP })),
  );
  const admitted = results.filter((r) => r.admitted);
  assert.equal(admitted.length, CAP, 'exactly CAP concurrent spends may pass');
  const usage = await store.usage(tenantId, sourceId, CAP);
  assert.equal(usage.used, CAP);
});
