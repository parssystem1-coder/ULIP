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
 *
 * Phase 16: ANALYSIS / REPROCESS jobs run the real AI analysis runtime
 * (@ulip/analysis): ANALYSIS_PENDING → ANALYZING → evidence → AI extraction
 * → taxonomy mapping → policy scoring → SCORED → QUALIFIED/REVIEW/REJECTED.
 * Provider selection happens BEFORE the ANALYZING transition; NOT_CONFIGURED
 * fails the job without touching the lead and never fabricates a result.
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
import {
  AnalysisRunError,
  AnalysisSkipError,
  DbAnalysisStore,
  DbScoringPolicyResolver,
  runAnalysisForLead,
  type AnalysisOutcome,
  type AnalysisJobPayload,
} from '@ulip/analysis';
import { loadAiConfig, selectAiRuntime, type AiRuntime } from '@ulip/ai';
import { DbOrchestrator, FAILURE_POLICY, type ErrorCode, type PipelineStep } from '@ulip/orchestration';
import { Database, loadEnv, Logger } from '@ulip/runtime';
import { createRedisConnection, Queue } from './queue.ts';

export interface WorkerDeps {
  env: ReturnType<typeof loadEnv>;
  log: Logger;
  db: Database;
  registry: ConnectorRegistry;
  ai: AiRuntime;
  analysisStore: DbAnalysisStore;
  policy: DbScoringPolicyResolver;
  orchestrator: DbOrchestrator;
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
  delayMs = 0,
): Promise<EnqueueResult> {
  const queue = new Queue(redisUrl);
  try {
    const opts: { priority: number; attempts: number; backoff: { type: string; delay: number }; delay?: number } = {
      priority,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    };
    if (delayMs > 0) opts.delay = delayMs;
    const bull = await queue.add('ulip-jobs', { jobId }, opts);
    return { bullJobId: bull.id ?? jobId };
  } finally {
    await queue.close();
  }
}

interface ClaimedRow {
  type: string;
  payload: Record<string, unknown>;
  tenant_id: string;
  correlation_id: string | null;
  attempt_count: number;
  max_attempts: number;
}

async function processJob(deps: WorkerDeps, bull: BullJob<{ jobId: string }>): Promise<void> {
  const { db, log } = deps;
  const jobId = bull.data?.jobId;
  if (typeof jobId !== 'string') throw new Error('queue message missing jobId');

  // Exactly-once claim from the source of truth.
  const claimed = await db.query(
    `UPDATE jobs SET status = 'RUNNING', started_at = now(), attempt_count = attempt_count + 1
     WHERE id = $1 AND status = 'PENDING'
     RETURNING type::text AS type, payload, tenant_id, correlation_id, attempt_count, max_attempts`,
    [jobId],
  );
  const row = claimed.rows[0] as ClaimedRow | undefined;
  if (row === undefined) {
    log.info('job not claimable (already running/finished)', { jobId });
    return;
  }
  const jobLog = log.bind({ jobId, type: row.type, tenantId: row.tenant_id });
  jobLog.info('job claimed', { attempt: row.attempt_count, maxAttempts: row.max_attempts });

  try {
    if (row.type === 'DISCOVERY') {
      await runDiscoveryFlowForJob({ db, log: jobLog, registry: deps.registry }, row.payload, {
        tenantId: row.tenant_id,
        jobId,
        correlationId: row.correlation_id,
      });
    } else if (row.type === 'ANALYSIS' || row.type === 'REPROCESS') {
      const leadId = String(row.payload['leadId'] ?? '');
      if (leadId !== '' && (await deps.analysisStore.hasSuccessfulRun(jobId, leadId))) {
        // Idempotent replay: this job already persisted its result rows.
        jobLog.info('analysis already completed for this job (idempotent replay)', { leadId });
      } else {
        await runAnalysisFlowForJob(deps, row.payload, {
          tenantId: row.tenant_id,
          jobId,
          correlationId: row.correlation_id,
          jobType: row.type,
        });
      }
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
    await handleJobFailure(deps, jobId, row, err, jobLog);
    throw err;
  }
}

/**
 * Applies the existing failure lifecycle (ADR-016 FAILURE_POLICY) to the
 * persistent job row. Analysis failures may re-arm the row as PENDING with a
 * delayed transport re-enqueue (DB stays the source of truth); everything
 * terminal is recorded as FAILED with an error code + job_attempts row.
 */
async function handleJobFailure(
  deps: WorkerDeps,
  jobId: string,
  row: ClaimedRow,
  err: unknown,
  jobLog: Logger,
): Promise<void> {
  const { db } = deps;
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AnalysisSkipError) {
    await db.query(`UPDATE jobs SET status = 'SKIPPED', error_code = 'SKIPPED', error_message = $2, completed_at = now() WHERE id = $1`, [jobId, message]);
    await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'STATUS', $2::jsonb)`, [
      jobId, JSON.stringify({ status: 'SKIPPED', message }),
    ]);
    jobLog.warn('job skipped', { reason: message });
    return;
  }

  const isAnalysis = err instanceof AnalysisRunError;
  const code: ErrorCode | string = isAnalysis
    ? (err as AnalysisRunError).code
    : err instanceof DiscoveryInputError
      ? 'BAD_REQUEST'
      : err instanceof ConnectorNotAvailableError
        ? 'NOT_CONFIGURED'
        : 'WORKER_ERROR';

  // Bounded retry: only when the failure policy says RETRY and attempts remain.
  if (isAnalysis) {
    const runErr = err as AnalysisRunError;
    const policyEntry = FAILURE_POLICY[runErr.code];
    const allowed = Math.min(policyEntry.maxAttempts ?? row.max_attempts, row.max_attempts);
    if (policyEntry.action === 'RETRY' && row.attempt_count < allowed) {
      const backoffSeconds = (policyEntry.backoffBaseSeconds ?? 30) * row.attempt_count;
      const runAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      const rearmed = await db.query(
        `UPDATE jobs SET status = 'PENDING', run_after = $2::timestamptz, error_code = $3, error_message = $4, updated_at = now()
         WHERE id = $1 AND status = 'RUNNING' RETURNING id`,
        [jobId, runAfter, code, message],
      );
      if ((rearmed.rowCount ?? 0) > 0) {
        await db.query(
          `INSERT INTO job_attempts (job_id, attempt_no, started_at, finished_at, outcome, error_code, error_message)
           VALUES ($1, $2, now() - interval '1 second', now(), 'RETRYABLE_FAILURE', $3, $4)
           ON CONFLICT (job_id, attempt_no) DO NOTHING`,
          [jobId, row.attempt_count, code, message],
        );
        await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'RETRY_SCHEDULED', $2::jsonb)`, [
          jobId,
          JSON.stringify({ attempt: row.attempt_count, allowed, backoffSeconds, runAfter, code }),
        ]);
        await enqueuePersistentJob(deps.env.REDIS_URL, jobId, 0, backoffSeconds * 1000).catch((e: unknown) =>
          jobLog.warn('retry re-enqueue failed (row stays PENDING)', { error: e instanceof Error ? e.message : String(e) }),
        );
        jobLog.warn('job scheduled for retry', { attempt: row.attempt_count, allowed, backoffSeconds });
        return;
      }
    }
    if (runErr.leadTransitioned && (runErr.action === 'RETRY' || runErr.action === 'FALLBACK')) {
      // Retry exhausted (or no fallback available): lead → FAILED.
      await deps.orchestrator
        .applyLeadEvent({ leadId: String(row.payload['leadId'] ?? ''), tenantId: row.tenant_id, event: 'ANALYSIS_FAILED', expectedFrom: 'ANALYZING', to: 'FAILED' })
        .catch((e: unknown) => jobLog.error('failed to move lead to FAILED', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  await db.query(
    `UPDATE jobs SET status = 'FAILED', error_code = $2, error_message = $3, failed_at = now() WHERE id = $1`,
    [jobId, code, message],
  );
  await db.query(
    `INSERT INTO job_attempts (job_id, attempt_no, started_at, finished_at, outcome, error_code, error_message)
     VALUES ($1, $2, now() - interval '1 second', now(), 'FATAL_FAILURE', $3, $4)
     ON CONFLICT (job_id, attempt_no) DO NOTHING`,
    [jobId, row.attempt_count, code, message],
  );
  await db.query(`INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'FAILED', $2::jsonb)`, [
    jobId,
    JSON.stringify({ message, code }),
  ]);
  jobLog.error('job failed', { error: message, code });
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

/**
 * Runs the AI analysis runtime for a claimed ANALYSIS/REPROCESS job.
 * Progress rows are written as the persistent job moves through its steps
 * (ANALYSIS → EVIDENCE_VALIDATION → SCORING).
 */
export async function runAnalysisFlowForJob(
  deps: WorkerDeps,
  payload: Record<string, unknown>,
  context: { tenantId: string; jobId: string; correlationId: string | null; jobType?: string },
): Promise<AnalysisOutcome> {
  const progress = (step: PipelineStep, percent: number): void => {
    void deps.db
      .query(
        `UPDATE jobs SET current_step = $2::job_step, progress = $3, updated_at = now() WHERE id = $1`,
        [context.jobId, step, percent],
      )
      .catch(() => undefined);
  };
  return runAnalysisForLead(
    {
      log: deps.log,
      store: deps.analysisStore,
      ai: deps.ai,
      policy: deps.policy,
      lifecycle: deps.orchestrator,
      progress,
    },
    payload,
    {
      tenantId: context.tenantId,
      jobId: context.jobId,
      correlationId: context.correlationId,
      ...(context.jobType !== undefined ? { jobType: context.jobType } : {}),
    },
  );
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

  // AI runtime: env-driven, provider-agnostic; fake never selected silently
  // in production (selectAiRuntime returns NOT_CONFIGURED there).
  const ai = selectAiRuntime(loadAiConfig());
  if (ai.status !== 'READY') {
    log.warn('AI runtime NOT_CONFIGURED — analysis jobs will fail honestly', {
      reason: ai.reason ?? 'unknown',
      missing: ai.missing.join(','),
    });
  } else {
    log.info('AI runtime ready', { provider: ai.meta.provider, kind: ai.meta.kind, model: ai.meta.modelVersion });
  }
  const analysisStore = new DbAnalysisStore(db);
  const policy = new DbScoringPolicyResolver(db);
  const orchestrator = new DbOrchestrator({ db });
  const deps: WorkerDeps = { env, log, db, registry, ai, analysisStore, policy, orchestrator };

  const worker = new Worker<{ jobId: string }>(
    'ulip-jobs',
    (bull) => processJob(deps, bull),
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
