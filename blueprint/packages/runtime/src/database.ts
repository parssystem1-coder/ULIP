/**
 * PostgreSQL runtime (Phase 14): a guarded pool + the migration runner.
 *
 * The database is the source of truth (ADR-016); these helpers only manage
 * connections and applying `database/migrations/NNNN_slug/up.sql` exactly once
 * in lexical order.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface DatabaseConfig {
  connectionString: string;
  max?: number;
}

export class Database {
  readonly pool: Pool;
  private readonly max: number;

  constructor(config: DatabaseConfig) {
    this.max = config.max ?? 10;
    this.pool = new Pool({ connectionString: config.connectionString, max: this.max });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[]);
  }

  /** Runs `fn` inside a transaction; rolls back on throw. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending `up.sql` migrations exactly once, in lexical order.
 * Uses a `schema_migrations` ledger table (created if missing).
 */
export async function runMigrations(db: Database, migrationsDir: string): Promise<MigrationOutcome> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = new Set<string>(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const outcome: MigrationOutcome = { applied: [], skipped: [] };
  for (const name of entries) {
    if (applied.has(name)) {
      outcome.skipped.push(name);
      continue;
    }
    const upPath = join(migrationsDir, name, 'up.sql');
    const sql = readFileSync(upPath, 'utf8');
    // The migration files wrap themselves in BEGIN/COMMIT.
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    outcome.applied.push(name);
  }
  return outcome;
}
