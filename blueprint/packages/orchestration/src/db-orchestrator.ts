/**
 * DbOrchestrator (Phase 16) — the implemented Orchestrator from contracts.ts.
 *
 * It is the ONLY writer of leads.status: every move is validated against
 * LEAD_TRANSITION_TABLE first, then applied conditionally (expectedFrom) so a
 * concurrent actor can never skip a state. Jobs are persisted FIRST (DB is
 * truth, ADR-016); the injected enqueue callback is transport only.
 */

import type { Database } from '@ulip/runtime';
import type { AnalysisMode } from '@ulip/domain/contracts';
import {
  LEAD_TRANSITION_TABLE,
  canTransition,
  type JobRecord,
  type Orchestrator,
  type ProcessingEvent,
  type ProcessingStage,
  type StartPipelineInput,
} from './contracts.ts';

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export interface EnqueueFn {
  (jobId: string, opts?: { priority?: number | undefined; delayMs?: number | undefined }): Promise<{ enqueued: boolean }>;
}

export interface DbOrchestratorOptions {
  db: Database;
  enqueue?: EnqueueFn | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JobRow {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  priority: number;
  progress: number;
  attempt_count: number;
  max_attempts: number;
  correlation_id: string | null;
  created_at: string;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type as JobRecord['type'],
    status: row.status as JobRecord['status'],
    priority: row.priority,
    progress: row.progress,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  } as JobRecord;
}

export class DbOrchestrator implements Orchestrator {
  private readonly db: Database;
  private readonly enqueue: EnqueueFn | undefined;

  constructor(options: DbOrchestratorOptions) {
    this.db = options.db;
    this.enqueue = options.enqueue;
  }

  /** Resolves the unique target stage for (from, event), honouring `to`. */
  private resolveTarget(from: ProcessingStage, event: ProcessingEvent, to?: ProcessingStage): ProcessingStage {
    const targets = LEAD_TRANSITION_TABLE.filter((t) => t.from === from && t.event === event).map((t) => t.to);
    if (targets.length === 0) throw new TransitionError(`no transition for ${from} + ${event}`);
    if (to !== undefined) {
      if (!targets.includes(to)) {
        throw new TransitionError(`invalid transition ${from} + ${event} → ${to}`);
      }
      return to;
    }
    const unique = [...new Set(targets)];
    if (unique.length !== 1) {
      throw new TransitionError(`ambiguous transition ${from} + ${event}: one of ${unique.join(', ')} required`);
    }
    return unique[0] as ProcessingStage;
  }

  async applyLeadEvent(input: {
    leadId: string;
    tenantId?: string | undefined;
    event: ProcessingEvent;
    expectedFrom: ProcessingStage;
    to?: ProcessingStage | undefined;
  }): Promise<ProcessingStage> {
    const target = this.resolveTarget(input.expectedFrom, input.event, input.to);
    if (!canTransition(LEAD_TRANSITION_TABLE, input.expectedFrom, input.event, target)) {
      throw new TransitionError(`undeclared transition ${input.expectedFrom} + ${input.event} → ${target}`);
    }
    const values: unknown[] = [input.leadId, input.expectedFrom, target];
    let sql = `UPDATE leads SET status = $3::lead_status, updated_at = now()
               WHERE id = $1 AND status = $2::lead_status`;
    if (input.tenantId !== undefined) {
      values.push(input.tenantId);
      sql += ` AND tenant_id = $4`;
    }
    sql += ' RETURNING status::text AS status';
    const r = await this.db.query<{ status: string }>(sql, values);
    if ((r.rowCount ?? 0) > 0) return target;

    const current = await this.db.query<{ status: string }>(
      'SELECT status::text AS status FROM leads WHERE id = $1',
      [input.leadId],
    );
    const now = current.rows[0]?.status;
    if (now === target) return target; // idempotent replay of the same event
    throw new TransitionError(
      `lead ${input.leadId} is ${now ?? 'missing'}, expected ${input.expectedFrom} for ${input.event}`,
    );
  }

  private async activeJob(tenantId: string, leadId: string): Promise<JobRecord | null> {
    const r = await this.db.query<JobRow>(
      `SELECT id, tenant_id, type, status::text AS status, priority, progress, attempt_count,
              max_attempts, correlation_id, created_at
       FROM jobs
       WHERE tenant_id = $1 AND status IN ('PENDING', 'RUNNING')
         AND payload->>'leadId' = $2 AND type IN ('ANALYSIS', 'REPROCESS')
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, leadId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  private async createJob(input: {
    tenantId: string;
    leadId: string;
    analysisMode: AnalysisMode;
    correlationId?: string | undefined;
    type: 'ANALYSIS' | 'REPROCESS';
    reason: string;
  }): Promise<JobRecord> {
    const correlation = input.correlationId !== undefined && UUID_RE.test(input.correlationId) ? input.correlationId : null;
    const r = await this.db.query<JobRow>(
      `INSERT INTO jobs (tenant_id, type, payload, correlation_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, tenant_id, type, status::text AS status, priority, progress,
                 attempt_count, max_attempts, correlation_id, created_at`,
      [
        input.tenantId, input.type,
        JSON.stringify({ leadId: input.leadId, analysisMode: input.analysisMode, reason: input.reason }),
        correlation,
      ],
    );
    const row = r.rows[0];
    if (row === undefined) throw new TransitionError('failed to persist job');
    await this.db.query(
      `INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'STATUS', $2::jsonb)`,
      [row.id, JSON.stringify({ status: 'PENDING', leadId: input.leadId, reason: input.reason })],
    );
    if (this.enqueue !== undefined) {
      await this.enqueue(row.id).catch(() => ({ enqueued: false }));
    }
    return toRecord(row);
  }

  async startAnalysis(input: StartPipelineInput): Promise<JobRecord> {
    const status = await this.leadStatus(input.tenantId, input.leadId);
    if (status === 'DEDUP_CHECKED') {
      await this.applyLeadEvent({
        leadId: input.leadId, tenantId: input.tenantId,
        event: 'QUEUE_ANALYSIS', expectedFrom: 'DEDUP_CHECKED',
      });
    } else if (status !== 'ANALYSIS_PENDING') {
      throw new TransitionError(`lead ${input.leadId} is ${status}, cannot start analysis`);
    }
    const active = await this.activeJob(input.tenantId, input.leadId);
    if (active !== null) return active;
    return this.createJob({
      tenantId: input.tenantId, leadId: input.leadId, analysisMode: input.analysisMode,
      type: 'ANALYSIS', reason: 'start',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  }

  async reprocess(input: StartPipelineInput): Promise<JobRecord> {
    const status = await this.leadStatus(input.tenantId, input.leadId);
    if (status !== 'ANALYSIS_PENDING') {
      if (!canTransition(LEAD_TRANSITION_TABLE, status as ProcessingStage, 'REPROCESS', 'ANALYSIS_PENDING')) {
        throw new TransitionError(`lead ${input.leadId} is ${status}; REPROCESS is not a legal move`);
      }
      await this.applyLeadEvent({
        leadId: input.leadId, tenantId: input.tenantId,
        event: 'REPROCESS', expectedFrom: status as ProcessingStage, to: 'ANALYSIS_PENDING',
      });
    }
    const active = await this.activeJob(input.tenantId, input.leadId);
    if (active !== null) return active;
    return this.createJob({
      tenantId: input.tenantId, leadId: input.leadId, analysisMode: input.analysisMode,
      type: 'REPROCESS', reason: 'reprocess',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  }

  async resume(input: { tenantId: string; leadId: string }): Promise<JobRecord> {
    const status = await this.leadStatus(input.tenantId, input.leadId);
    if (status !== 'ANALYSIS_PENDING') {
      throw new TransitionError(`lead ${input.leadId} is ${status}; nothing to resume`);
    }
    const active = await this.activeJob(input.tenantId, input.leadId);
    if (active !== null) return active;
    return this.createJob({
      tenantId: input.tenantId, leadId: input.leadId, analysisMode: 'STANDARD',
      type: 'ANALYSIS', reason: 'resume',
    });
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const pending = await this.db.query<JobRow>(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'PENDING'
       RETURNING id, tenant_id, type, status::text AS status, priority, progress,
                 attempt_count, max_attempts, correlation_id, created_at`,
      [jobId],
    );
    const row = pending.rows[0];
    if (row !== undefined) {
      await this.db.query(
        `INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'CANCEL_REQUESTED', $2::jsonb)`,
        [jobId, JSON.stringify({ cancelledWhile: 'PENDING' })],
      );
      return toRecord(row);
    }
    await this.db.query(
      `INSERT INTO job_events (job_id, event_type, payload) VALUES ($1, 'CANCEL_REQUESTED', $2::jsonb)`,
      [jobId, JSON.stringify({ cancelledWhile: 'RUNNING' })],
    );
    const current = await this.db.query<JobRow>(
      `SELECT id, tenant_id, type, status::text AS status, priority, progress, attempt_count,
              max_attempts, correlation_id, created_at FROM jobs WHERE id = $1`,
      [jobId],
    );
    const existing = current.rows[0];
    if (existing === undefined) throw new TransitionError(`job ${jobId} not found`);
    return toRecord(existing);
  }

  private async leadStatus(tenantId: string, leadId: string): Promise<string> {
    const r = await this.db.query<{ status: string }>(
      'SELECT status::text AS status FROM leads WHERE id = $1 AND tenant_id = $2',
      [leadId, tenantId],
    );
    const status = r.rows[0]?.status;
    if (status === undefined) throw new TransitionError(`lead ${leadId} not found in tenant ${tenantId}`);
    return status;
  }
}
