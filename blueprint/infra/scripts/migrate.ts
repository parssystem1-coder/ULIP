/**
 * Migration runner entry (Phase 14). Applies database/migrations in lexical
 * order exactly once (ledger: schema_migrations). Exits non-zero on failure.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database, loadEnv, runMigrations, Logger } from '@ulip/runtime';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'database', 'migrations');

const env = loadEnv();
const log = new Logger(env.LOG_LEVEL, { app: 'ulip-migrate' });
const db = new Database({ connectionString: process.env.ULIP_PG_URL ?? env.DATABASE_URL, max: 2 });

try {
  const outcome = await runMigrations(db, MIGRATIONS_DIR);
  log.info('migrations complete', { applied: outcome.applied.length, skipped: outcome.skipped.length });
  for (const name of outcome.applied) log.info('applied', { name });
  process.exit(0);
} catch (err) {
  log.error('migration failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
} finally {
  await db.close().catch(() => undefined);
}
