/**
 * Social Actions + Outreach constraint tests (migration 0002, ADR-026).
 *
 * Runs against a REAL PostgreSQL when available (same harness as
 * db-constraints.test.ts):
 *   docker run -d --name ulip-pg-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ulip -p 55432:5432 postgres:16
 *   ULIP_PG_URL=postgresql://postgres:postgres@localhost:55432/ulip node --experimental-strip-types --test database/tests/social-outreach-constraints.test.ts
 *
 * When PostgreSQL is unavailable each test SKIPS with an explicit reason —
 * the suite never silently passes.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = join(ROOT, 'database', 'schema', 'schema.sql');
const UP_0002 = join(ROOT, 'database', 'migrations', '0002_social_actions_outreach', 'up.sql');
const DOWN_0002 = join(ROOT, 'database', 'migrations', '0002_social_actions_outreach', 'down.sql');
const DOWN_0001 = join(ROOT, 'database', 'migrations', '0001_initial_core', 'down.sql');

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
    console.warn(`\n[SKIP] social-outreach-constraints: ${skipReason}\n`);
  }
});

after(async () => {
  if (available) {
    try {
      await client.query(DOWN_0001); // full teardown (incl. 0002 objects)
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

/** Applies 0001 then 0002 (the exact production evolution order). */
async function applySchema() {
  await client.query(readFileSync(SCHEMA, 'utf8'));
}

const T1 = '10000000-0000-0000-0000-0000000aa001';
const T2 = '10000000-0000-0000-0000-0000000aa002';
const U1 = '10000000-0000-0000-0000-0000000bb001';

async function seedTenantUser(): Promise<{ tenantId: string; leadId: string; userId: string }> {
  await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'T1') ON CONFLICT DO NOTHING`, [T1]);
  await client.query(
    `INSERT INTO users (id, tenant_id, email, role) VALUES ($1, $2, 'u1@t1.test', 'ANALYST')
     ON CONFLICT DO NOTHING`,
    [U1, T1],
  );
  // minimal business + lead for FK targets
  await client.query(
    `INSERT INTO businesses (id, tenant_id, canonical_name) VALUES ($1, $2, 'Biz One')
     ON CONFLICT DO NOTHING`,
    ['10000000-0000-0000-0000-0000000cc001', T1],
  );
  await client.query(
    `INSERT INTO leads (id, tenant_id, business_id, status) VALUES ($1, $2, $3, 'QUALIFIED')
     ON CONFLICT DO NOTHING`,
    ['10000000-0000-0000-0000-0000000dd001', T1, '10000000-0000-0000-0000-0000000cc001'],
  );
  return { tenantId: T1, leadId: '10000000-0000-0000-0000-0000000dd001', userId: U1 };
}

test('0002 objects exist: tables, enums and OUTREACH job type', async (t) => {
  if (!withDb(t)) return;
  await applySchema();
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN
     ('social_actions','social_action_attempts','message_templates','outreach_campaigns',
      'outreach_recipients','lead_contact_history','suppression_entries')`,
  );
  assert.equal(tables.rowCount, 7);

  const jobType = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'jobs_type_check'`,
  );
  assert.match(jobType.rows[0]?.def ?? '', /OUTREACH/);
});

test('social_actions idempotency: same tenant+key rejected, different tenant allowed', async (t) => {
  if (!withDb(t)) return;
  const { tenantId, leadId, userId } = await seedTenantUser();

  const insert = `INSERT INTO social_actions
    (tenant_id, lead_id, source_type, type, idempotency_key, actor_id)
    VALUES ($1, $2, 'instagram', 'FOLLOW_PROFILE', 'key-1', $3)`;

  await client.query(insert, [tenantId, leadId, userId]);
  await assert.rejects(
    () => client.query(insert, [tenantId, leadId, userId]),
    /duplicate key|unique/i,
  );
  // same key in ANOTHER tenant is fine (scope is per tenant)
  await client.query(`INSERT INTO tenants (id, name) VALUES ($1, 'T2') ON CONFLICT DO NOTHING`, [T2]);
  await client.query(
    `INSERT INTO leads (id, tenant_id, business_id, status) VALUES ($1, $2, $3, 'QUALIFIED')
     ON CONFLICT DO NOTHING`,
    ['10000000-0000-0000-0000-0000000dd002', T2, '10000000-0000-0000-0000-0000000cc001'],
  );
  await client.query(insert, [T2, '10000000-0000-0000-0000-0000000dd002', null]);
});

test('suppression_entries: wrong scope/target combination is rejected', async (t) => {
  if (!withDb(t)) return;
  const { tenantId } = await seedTenantUser();
  // LEAD scope without a lead → CHECK violation
  await assert.rejects(
    () =>
      client.query(
        `INSERT INTO suppression_entries (tenant_id, scope, reason) VALUES ($1, 'LEAD', 'MANUAL')`,
        [tenantId],
      ),
    /chk_suppression_target|check/i,
  );
  // EMAIL scope with a value → accepted
  await client.query(
    `INSERT INTO suppression_entries (tenant_id, scope, value_text, reason)
     VALUES ($1, 'EMAIL', 'spam@example.com', 'BOUNCE')`,
    [tenantId],
  );
});

test('outreach_recipients: one row per (campaign, lead)', async (t) => {
  if (!withDb(t)) return;
  const { tenantId, leadId, userId } = await seedTenantUser();
  await client.query(
    `INSERT INTO message_templates (id, tenant_id, name, body, created_by)
     VALUES ('10000000-0000-0000-0000-0000000ee001', $1, 't1', 'salam', $2)`,
    [tenantId, userId],
  );
  await client.query(
    `INSERT INTO outreach_campaigns (id, tenant_id, name, template_id, created_by)
     VALUES ('10000000-0000-0000-0000-0000000ee002', $1, 'c1',
             '10000000-0000-0000-0000-0000000ee001', $2)`,
    [tenantId, userId],
  );
  const insert = `INSERT INTO outreach_recipients (tenant_id, campaign_id, lead_id)
    VALUES ($1, '10000000-0000-0000-0000-0000000ee002', $2)`;
  await client.query(insert, [tenantId, leadId]);
  await assert.rejects(
    () => client.query(insert, [tenantId, leadId]),
    /duplicate key|unique/i,
  );
});

test('down 0002 → up 0002 round-trips cleanly (no leftover objects)', async (t) => {
  if (!withDb(t)) return;
  // The suite DB holds the full schema (test 1) + seeded rows. down-0002 must
  // return it to the 0001-only state and up-0002 must re-apply on top of it —
  // exactly the lifecycle the migration runner performs.
  await client.query(readFileSync(DOWN_0002, 'utf8'));
  const leftovers = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
     AND table_name IN ('social_actions','social_action_attempts','message_templates',
     'outreach_campaigns','outreach_recipients','lead_contact_history','suppression_entries')`,
  );
  assert.equal(leftovers.rowCount, 0);
  const enumsGone = await client.query(
    `SELECT 1 FROM pg_type WHERE typtype = 'e' AND typname IN
     ('social_action_capability','social_action_type','social_action_status',
      'social_action_attempt_outcome','contact_channel','contact_direction',
      'message_template_status','outreach_campaign_status','outreach_recipient_status',
      'suppression_scope')`,
  );
  assert.equal(enumsGone.rowCount, 0);
  await client.query(readFileSync(UP_0002, 'utf8'));
  const restored = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
     AND table_name = 'social_actions'`,
  );
  assert.equal(restored.rowCount, 1);
});
