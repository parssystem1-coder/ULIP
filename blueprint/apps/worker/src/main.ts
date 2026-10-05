/**
 * ULIP Worker runtime (Phase 14, ADR-016).
 *
 * Redis/BullMQ is TRANSPORT ONLY: the queue message carries just the job id.
 * Before processing, the worker claims the persistent Job row
 * (PENDING → RUNNING, exactly-once via conditional UPDATE). All state
 * transitions and results are written back to PostgreSQL; if Redis is down
 * the job rows remain PENDING and are re-enqueued on recovery.
 */

import { Worker, type ConnectionOptions, type Job as BullJob } from 'bullmq';
import { Database, loadEnv, Logger } from '@ulip/runtime';
import { createRedisConnection, Queue } from './queue.ts';

export interface WorkerDeps {
  env: ReturnType<typeof loadEnv>;
  log: Logger;
  db: Database;
}

export interface EnqueueResult {
  bullJobId: string;
}

/** Enqueues a persistent job id onto the transport queue. */
export async function enqueuePersistentJob(
  redisUrl: string,
  jobId: string,
  priority = 0,
): Promise<EnqueueResult> {
  const queue = new Queue(redisUrl);
  try {
    const bull = await queue.add(
      'ulip-jobs',
      { jobId },
      { priority, attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );
    return { bullJobId: bull.id ?? jobId };
  } finally {
    await queue.close();
  }
}

/** Real first flow: DISCOVERY — a bounded, honest mock of source ingestion. */
export async function runDiscoveryFlow(
  db: Database,
  log: Logger,
  payload: Record<string, unknown>,
): Promise<{ itemsFound: number }> {
  const sourceId = typeof payload['sourceId'] === 'string' ? payload['sourceId'] : null;
  const tenantId = typeof payload['tenantId'] === 'string' ? payload['tenantId'] : null;
  if (sourceId === null || tenantId === null) {
    throw new Error('DISCOVERY payload requires sourceId and tenantId');
  }
  // Verify the source belongs to the tenant (defence in depth — payload is untrusted).
  const source = await db.query(`SELECT id FROM sources WHERE id = $1 AND tenant_id = $2`, [sourceId, tenantId]);
  if ((source.rowCount ?? 0) === 0) {
    throw new Error('source not found in tenant');
  }
  // Real flow stub: record that discovery ran and found zero candidates.
  // Future phases plug the connector framework here (Phase 05+).
  const itemsFound = 0;
  log.info('discovery flow executed', { sourceId, itemsFound });
  return { itemsFound };
}

async function processJob(deps: WorkerDeps, bull: BullJob<{ jobId: string }>): Promise<void> {
  const { db, log } = deps;
  const jobId = bull.data?.jobId;
  if (typeof jobId !== 'string') throw new Error('queue message missing jobId');

  // Exactly-once claim from the source of truth.
  const claimed = await db.query(
    `UPDATE jobs SET status = 'RUNNING', started_at = now(), attempt_count = attempt_count + 1
     WHERE id = $1 AND status = 'PENDING' RETURNING type::text AS type, payload, tenant_id`,
    [jobId],
  );
  const row = claimed.rows[0] as { type: string; payload: Record<string, unknown>; tenant_id: string } | undefined;
  if (row === undefined) {
    log.info('job not claimable (already running/finished)', { jobId });
    return;
  }
  const jobLog = log.bind({ jobId, type: row.type, tenantId: row.tenant_id });
  jobLog.info('job claimed');

  try {
    if (row.type === 'DISCOVERY') {
      await runDiscoveryFlow(db, jobLog, { ...row.payload, tenantId: row.tenant_id });
    } else {
      throw new Error(`no worker flow implemented for job type ${row.type}`);
    }
    await db.query(`UPDATE jobs SET status = 'SUCCEEDED', progress = 100, completed_at = now() WHERE id = $1`, [jobId]);
    await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'COMPLETED', '{}'::jsonb)`, [jobId]);
    jobLog.info('job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE jobs SET status = 'FAILED', error_code = 'WORKER_ERROR', error_message = $2, failed_at = now() WHERE id = $1`,
      [jobId, message],
    );
    await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'FAILED', $2::jsonb)`, [jobId, JSON.stringify({ message })]);
    jobLog.error('job failed', { error: message });
    throw err;
  }
}

export async function startWorker(overrides: Partial<ReturnType<typeof loadEnv>> = {}): Promise<{
  worker: Worker;
  close(): Promise<void>;
}> {
  const env = { ...loadEnv(), ...overrides };
  const log = new Logger(env.LOG_LEVEL, { app: 'ulip-worker', env: env.NODE_ENV });
  const db = new Database({ connectionString: env.DATABASE_URL, max: 5 });
  const redis = createRedisConnection(env.REDIS_URL);

  const worker = new Worker<{ jobId: string }>(
    'ulip-jobs',
    (bull) => processJob({ env, log, db }, bull),
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
