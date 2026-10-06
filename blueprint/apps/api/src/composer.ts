/**
 * Composition root (Phase 14). Wires env → logger → database → repositories.
 * Single Database instance; connections are pooled and closed on shutdown.
 */

import { ConnectorRegistry, ConfiguredHttpApiConnectorFactory, DeterministicFakeConnectorFactory } from '@ulip/discovery';
import { DbOrchestrator } from '@ulip/orchestration';
import { Database, JobQueue, loadEnv, Logger, type Env } from '@ulip/runtime';
import {
  AnalysisRepository,
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
  /** Read side of the AI analysis runtime (Phase 16). */
  analysis: AnalysisRepository;
  /** The ONLY writer of leads.status (ADR-016). */
  orchestrator: DbOrchestrator;
  /** Redis/BullMQ transport for persistent jobs (transport ONLY, ADR-016). */
  queue: JobQueue;
  /** Connector factories for capability validation (Phase 15, ADR-027). */
  connectorRegistry: ConnectorRegistry;
  close(): Promise<void>;
}

export async function compose(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = { ...loadEnv(), ...overrides };
  const log = new Logger(env.LOG_LEVEL, { app: env.APP_NAME, env: env.NODE_ENV });
  const db = new Database({ connectionString: env.DATABASE_URL, max: 10 });
  const queue = new JobQueue(env.REDIS_URL);
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  connectorRegistry.register(new ConfiguredHttpApiConnectorFactory('INSTAGRAM'));
  connectorRegistry.register(new DeterministicFakeConnectorFactory());

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
    analysis: new AnalysisRepository(db),
    orchestrator: new DbOrchestrator({
      db,
      enqueue: async (jobId: string) => {
        try {
          await queue.add({ jobId });
          return { enqueued: true };
        } catch {
          // Redis down: the persisted job stays PENDING (DB is truth).
          return { enqueued: false };
        }
      },
    }),
    queue,
    connectorRegistry,
    async close(): Promise<void> {
      await db.close();
      await queue.close().catch(() => undefined);
    },
  };
  return ctx;
}
