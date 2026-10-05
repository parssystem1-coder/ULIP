/**
 * Composition root (Phase 14). Wires env → logger → database → repositories.
 * Single Database instance; connections are pooled and closed on shutdown.
 */

import { Database, JobQueue, loadEnv, Logger, type Env } from '@ulip/runtime';
import {
  CampaignRepository,
  JobRepository,
  LeadRepository,
  SourceRepository,
  TaxonomyRepository,
  TenantRepository,
  UserRepository,
} from './repositories.ts';

export interface AppContext {
  env: Env;
  log: Logger;
  db: Database;
  tenants: TenantRepository;
  users: UserRepository;
  sources: SourceRepository;
  taxonomy: TaxonomyRepository;
  leads: LeadRepository;
  campaigns: CampaignRepository;
  jobs: JobRepository;
  /** Redis/BullMQ transport for persistent jobs (transport ONLY, ADR-016). */
  queue: JobQueue;
  close(): Promise<void>;
}

export async function compose(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = { ...loadEnv(), ...overrides };
  const log = new Logger(env.LOG_LEVEL, { app: env.APP_NAME, env: env.NODE_ENV });
  const db = new Database({ connectionString: env.DATABASE_URL, max: 10 });
  const queue = new JobQueue(env.REDIS_URL);

  const ctx: AppContext = {
    env,
    log,
    db,
    tenants: new TenantRepository(db),
    users: new UserRepository(db),
    sources: new SourceRepository(db),
    taxonomy: new TaxonomyRepository(db),
    leads: new LeadRepository(db),
    campaigns: new CampaignRepository(db),
    jobs: new JobRepository(db),
    queue: new JobQueue(env.REDIS_URL),
    async close(): Promise<void> {
      await db.close();
      await queue.close().catch(() => undefined);
    },
  };
  return ctx;
}
