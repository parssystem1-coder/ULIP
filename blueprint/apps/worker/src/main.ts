/**
 * ULIP Worker runtime (Phases 14–15, ADR-016, ADR-027).
 *
 * Redis/BullMQ is TRANSPORT ONLY: the queue message carries just the job id.
 * Before processing, the worker claims the persistent Job row
 * (PENDING → RUNNING, exactly-once via conditional UPDATE). All state
 * transitions and results are written back to PostgreSQL; if Redis is down
 * the job rows remain PENDING and are re-enqueued on recovery.
 *
 * Phase 15: the DISCOVERY flow is the REAL pipeline
 * (connector → raw snapshot → normalization → dedup/ER → lead →
 * ANALYSIS_PENDING). Deterministic fake connectors run ONLY when the job
 * payload explicitly opts in (`allowFake: true`) — local E2E only.
 */

import { Worker, type ConnectionOptions, type Job as BullJob } from 'bullmq';
import {
  ConnectorNotAvailableError,
  DbEntityResolver,
  DbRawEntityStore,
  DeterministicFakeConnectorFactory,
  ConfiguredHttpApiConnectorFactory,
  ConnectorRegistry,
  DiscoveryInputError,
  PersianAwareNormalizer,
  runDiscovery,
} from '@ulip/discovery';
import { Database, loadEnv, Logger } from '@ulip/runtime';
import { createRedisConnection, Queue } from './queue.ts';

export interface WorkerDeps {
  env: ReturnType<typeof loadEnv>;
  log: Logger;
  db: Database;
  registry: ConnectorRegistry;
}

export interface EnqueueResult {
  bullJobId: string;
}

/** Shared worker-side registry: production boundary + explicit-E2E fakes. */
export function buildConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  registry.register(new ConfiguredHttpApiConnectorFactory('INSTAGRAM'));
  registry.register(new DeterministicFakeConnectorFactory());
  return registry;
}

/** Enqueues a persistent job id onto the transport queue. */
export async function enqueuePersistentJob(
  redisUrl: string,
  jobId: string,
  priority = 0,
): Promise<EnqueueResult> {
  const queue = new Queue(redisUrl);
  try {
    const bull = await queue.add('ulip-jobs', { jobId }, { priority, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
    return { bullJobId: bull.id ?? jobId };
  } finally {
    await queue.close();
  }
}

async function processJob(deps: WorkerDeps, bull: BullJob<{ jobId: string }>): Promise<void> {
  const { db, log } = deps;
  const jobId = bull.data?.jobId;
  if (typeof jobId !== 'string') throw new Error('queue message missing jobId');

  // Exactly-once claim from the source of truth.
  const claimed = await db.query(
    `UPDATE jobs SET status = 'RUNNING', started_at = now(), attempt_count = attempt_count + 1
     WHERE id = $1 AND status = 'PENDING' RETURNING type::text AS type, payload, tenant_id, correlation_id`,
    [jobId],
  );
  const row = claimed.rows[0] as
    | { type: string; payload: Record<string, unknown>; tenant_id: string; correlation_id: string | null }
    | undefined;
  if (row === undefined) {
    log.info('job not claimable (already running/finished)', { jobId });
    return;
  }
  const jobLog = log.bind({ jobId, type: row.type, tenantId: row.tenant_id });
  jobLog.info('job claimed');

  try {
    if (row.type === 'DISCOVERY') {
      await runDiscoveryFlowForJob({ db, log: jobLog, registry: deps.registry }, row.payload, {
        tenantId: row.tenant_id,
        jobId,
        correlationId: row.correlation_id,
      });
    } else {
      throw new Error(`no worker flow implemented for job type ${row.type}`);
    }
    await db.query(`UPDATE jobs SET status = 'SUCCEEDED', progress = 100, completed_at = now() WHERE id = $1`, [jobId]);
    await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'COMPLETED', $2::jsonb)`, [
      jobId,
      JSON.stringify({ type: row.type }),
    ]);
    jobLog.info('job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof DiscoveryInputError ? 'BAD_REQUEST' : err instanceof ConnectorNotAvailableError ? 'NOT_CONFIGURED' : 'WORKER_ERROR';
    await db.query(
      `UPDATE jobs SET status = 'FAILED', error_code = $2, error_message = $3, failed_at = now() WHERE id = $1`,
      [jobId, code, message],
    );
    await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'FAILED', $2::jsonb)`, [
      jobId,
      JSON.stringify({ message, code }),
    ]);
    jobLog.error('job failed', { error: message, code });
    throw err;
  }
}

export interface DiscoveryRunOutcome {
  requested: number;
  discovered: number;
  unchanged: number;
  created: number;
  updated: number;
  rawPersisted: number;
}

/** Wraps the real discovery flow with job-scoped deps + honest outcomes. */
export async function runDiscoveryFlowForJob(
  deps: { db: Database; log: WorkerDeps['log']; registry: ConnectorRegistry },
  payload: Record<string, unknown>,
  context: { tenantId: string; jobId: string; correlationId: string | null },
): Promise<DiscoveryRunOutcome> {
  const rawEntities = new DbRawEntityStore(deps.db);
  const resolver = new DbEntityResolver(deps.db);
  const normalizer = new PersianAwareNormalizer();

  const allowFake = payload['allowFake'] === true;

  const outcome = await runDiscovery(
    {
      log: deps.log,
      connectorRegistry: deps.registry,
      rawEntities,
      normalizer,
      resolver,
      sources: {
        async findById(tenantId, sourceId) {
          const r = await deps.db.query<{ id: string; tenant_id: string; type: string; name: string; status: string; config: Record<string, unknown> }>(
            'SELECT id, tenant_id, type, name, status, config FROM sources WHERE id = $1 AND tenant_id = $2',
            [sourceId, tenantId],
          );
          const row = r.rows[0];
          return row === undefined ? null : { id: row.id, tenantId: row.tenant_id, type: row.type, name: row.name, status: row.status, config: row.config };
        },
      },
    },
    payload,
    { tenantId: context.tenantId, jobId: context.jobId, requestId: context.correlationId ?? undefined },
  );

  void allowFake;
  return outcome;
}

export async function startWorker(overrides: Partial<ReturnType<typeof loadEnv>> = {}): Promise<{
  worker: Worker;
  close(): Promise<void>;
}> {
  const env = { ...loadEnv(), ...overrides };
  const log = new Logger(env.LOG_LEVEL, { app: 'ulip-worker', env: env.NODE_ENV });
  const db = new Database({ connectionString: env.DATABASE_URL, max: 5 });
  const registry = buildConnectorRegistry();
  const redis = createRedisConnection(env.REDIS_URL);

  const worker = new Worker<{ jobId: string }>(
    'ulip-jobs',
    (bull) => processJob({ env, log, db, registry }, bull),
    { connection: redis.connection as ConnectionOptions, concurrency: 2 },
  );
  worker.on('failed', (bull, err) => log.error('bull job failed', { bullJobId: bull?.id, error: err.message }));

  const close = async (): Promise<void> => {
    await worker.close();
    redis.disconnect();
    await db.close();
  };
  log.info('worker started', { queue: 'ulip-jobs' });
  return { worker, close };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '#');
if (isMain) {
  await startWorker();
}
