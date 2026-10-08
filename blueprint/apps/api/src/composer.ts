/**
 * Composition root (Phase 14). Wires env → logger → database → repositories.
 * Single Database instance; connections are pooled and closed on shutdown.
 */

import { selectAiRuntimeFromEnv } from '@ulip/ai';
import { ConnectorRegistry, ConfiguredHttpApiConnectorFactory, DeterministicFakeConnectorFactory, InstagramGraphConnectorFactory } from '@ulip/discovery';
import { DbEvalStore } from '@ulip/eval';
import { DbOrchestrator } from '@ulip/orchestration';
import { CapabilityDiscoveryPlanner, DbSearchExecutor, DbTaxonomyResolver, SearchService } from '@ulip/search';
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
  /** Evaluation read side + corrections (Phase 17, ADR-029). */
  evaluation: DbEvalStore;
  /** The ONLY writer of leads.status (ADR-016). */
  orchestrator: DbOrchestrator;
  /** Redis/BullMQ transport for persistent jobs (transport ONLY, ADR-016). */
  queue: JobQueue;
  /** Connector factories for capability validation (Phase 15, ADR-027). */
  connectorRegistry: ConnectorRegistry;
  /** NL + structured search engine (Phase 20) — parser honest per AI runtime. */
  search: SearchService;
  close(): Promise<void>;
}

export async function compose(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = { ...loadEnv(), ...overrides };
  const log = new Logger(env.LOG_LEVEL, { app: env.APP_NAME, env: env.NODE_ENV });
  const db = new Database({ connectionString: env.DATABASE_URL, max: 10 });
  const queue = new JobQueue(env.REDIS_URL);
  const connectorRegistry = new ConnectorRegistry();
  connectorRegistry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  // Phase 19: REAL authorized Instagram Graph connector (ADR-031). Resolves
  // only when the source row config carries instagram-graph credentials.
  connectorRegistry.register(new InstagramGraphConnectorFactory());
  connectorRegistry.register(new DeterministicFakeConnectorFactory());

  // Phase 20: search engine. The LLM parser is attached ONLY when the AI
  // runtime is READY; otherwise the deterministic rules fallback parses and
  // the response states `parser.kind = RULES_FALLBACK` honestly.
  const aiRuntime = selectAiRuntimeFromEnv();
  const searchService = new SearchService({
    llm: aiRuntime.status === 'READY' && aiRuntime.llm !== null ? aiRuntime.llm : null,
    taxonomy: new DbTaxonomyResolver(db),
    executor: new DbSearchExecutor(db),
    planner: new CapabilityDiscoveryPlanner(
      {
        listSources: async (tenantId) => {
          const rows = await sourceRepoFor(tenantId);
          return rows;
        },
        // DB first (source of truth), then BullMQ transport (ADR-016).
        enqueueDiscovery: async (input) => {
          const job = await jobsRepoFor(input.tenantId, input.sourceId, input.query, input.filters, input.correlationId);
          try {
            await queue.add({ jobId: job.id });
          } catch {
            // Persisted PENDING; re-driven on recovery.
          }
          return { jobId: job.id };
        },
      },
      connectorRegistry,
    ),
    log,
  });
  const sources = new SourceRepository(db);
  const jobs = new JobRepository(db);
  const sourceRepoFor = async (tenantId: string) => {
    const rows = await sources.list(tenantId);
    return rows.map((s) => ({ id: s.id, tenantId: s.tenant_id, type: s.type, name: s.name, status: s.status, config: s.config }));
  };
  const jobsRepoFor = (
    tenantId: string,
    sourceId: string,
    query: string | undefined,
    filters: Record<string, string> | undefined,
    correlationId: string | undefined,
  ) =>
    jobs.create(tenantId, {
      type: 'DISCOVERY',
      payload: { sourceId, ...(query !== undefined ? { query } : {}), ...(filters !== undefined ? { filters } : {}) },
      correlationId,
    });

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
    evaluation: new DbEvalStore(db),
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
    search: searchService,
    async close(): Promise<void> {
      await db.close();
      await queue.close().catch(() => undefined);
    },
  };
  return ctx;
}
