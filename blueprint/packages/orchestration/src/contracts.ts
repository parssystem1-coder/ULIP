/**
 * Orchestration contracts (ADR-016).
 *
 * The Analysis Orchestrator OWNS the lead processing lifecycle. BullMQ executes
 * steps; the database (jobs/job_attempts/job_events + leads.status) is the
 * source of truth for processing state. These types are the canonical
 * transition/failure tables; docs/architecture/ORCHESTRATION.md mirrors them.
 */

import type { LeadStatus } from '@ulip/domain/contracts';

// ---------------------------------------------------------------------------
// Job lifecycle (mirrors job_status / job_step enums in schema.sql)
// ---------------------------------------------------------------------------

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

export type JobType =
  | 'DISCOVERY'
  | 'NORMALIZATION'
  | 'DEDUP'
  | 'ANALYSIS'
  | 'SCORING'
  | 'EXPORT'
  | 'REPROCESS';

export type PipelineStep =
  | 'DISCOVERY'
  | 'FETCH'
  | 'NORMALIZATION'
  | 'DEDUP'
  | 'ANALYSIS'
  | 'VISION'
  | 'DECISION'
  | 'EVIDENCE_VALIDATION'
  | 'SCORING';

export interface JobRecord {
  id: string;
  tenantId: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  currentStep?: PipelineStep;
  progress: number; // 0..100
  attemptCount: number;
  maxAttempts: number;
  correlationId?: string;
  parentJobId?: string;
  runAfter?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

export type FailureAction = 'RETRY' | 'FALLBACK' | 'SKIP' | 'REVIEW' | 'TERMINAL_FAIL';

export type ErrorCode =
  | 'CONNECTOR_ERROR'
  | 'RATE_LIMITED'
  | 'DATA_UNAVAILABLE'
  | 'INVALID_DATA'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'AI_PROVIDER_ERROR'
  | 'AI_UNAVAILABLE'
  | 'CONNECTOR_UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface FailurePolicyEntry {
  action: FailureAction;
  /** Max attempts when action is RETRY; ignored otherwise. */
  maxAttempts?: number;
  /** Exponential backoff base in seconds when action is RETRY. */
  backoffBaseSeconds?: number;
}

/**
 * Failure transition table (action per error code). Database-unavailable is
 * intentionally out of this map: with the DB as source of truth, that failure
 * is handled by process-level supervisor/alerting, not by a state row.
 */
export const FAILURE_POLICY: Readonly<Record<ErrorCode, FailurePolicyEntry>> = {
  CONNECTOR_ERROR: { action: 'RETRY', maxAttempts: 3, backoffBaseSeconds: 30 },
  RATE_LIMITED: { action: 'RETRY', maxAttempts: 3, backoffBaseSeconds: 60 },
  TIMEOUT: { action: 'RETRY', maxAttempts: 3, backoffBaseSeconds: 30 },
  DATA_UNAVAILABLE: { action: 'SKIP' },
  INVALID_DATA: { action: 'TERMINAL_FAIL' },
  SCHEMA_VALIDATION_ERROR: { action: 'RETRY', maxAttempts: 2, backoffBaseSeconds: 5 },
  AI_PROVIDER_ERROR: { action: 'FALLBACK' },
  AI_UNAVAILABLE: { action: 'REVIEW' },
  CONNECTOR_UNAVAILABLE: { action: 'RETRY', maxAttempts: 2, backoffBaseSeconds: 120 },
  CANCELLED: { action: 'TERMINAL_FAIL' },
  UNKNOWN: { action: 'RETRY', maxAttempts: 2, backoffBaseSeconds: 30 },
};

// ---------------------------------------------------------------------------
// Lead processing state machine (canonical)
// ---------------------------------------------------------------------------

export type ProcessingStage = Extract<
  LeadStatus,
  | 'DISCOVERED'
  | 'RAW_STORED'
  | 'NORMALIZED'
  | 'DEDUP_CHECKED'
  | 'ANALYSIS_PENDING'
  | 'ANALYZING'
  | 'SCORED'
  | 'REVIEW_REQUIRED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'FAILED'
  | 'ARCHIVED'
>;

export type ProcessingEvent =
  | 'RAW_STORED'
  | 'NORMALIZED'
  | 'DEDUP_RESOLVED'
  | 'QUEUE_ANALYSIS'
  | 'ANALYSIS_STARTED'
  | 'ANALYSIS_SUCCEEDED'
  | 'ANALYSIS_FAILED'
  | 'SCORED'
  | 'THRESHOLD_MAP'
  | 'HUMAN_REVIEWED'
  | 'ARCHIVE'
  | 'RETRY_EXHAUSTED'
  | 'REPROCESS';

export interface ProcessingTransition {
  from: ProcessingStage;
  event: ProcessingEvent;
  to: ProcessingStage;
}

/**
 * Canonical lead state transition table (ADR-016).
 *
 * Vision/Decision steps happen INSIDE the ANALYZING state — they are internal
 * pipeline steps, not separate lead lifecycle states.
 *
 * Rules:
 *  - THRESHOLD_MAP (policy-driven) is the ONLY way into REVIEW_REQUIRED /
 *    QUALIFIED / REJECTED from SCORED.
 *  - ANALYSIS_FAILED maps by failure policy: AI_UNAVAILABLE → REVIEW_REQUIRED;
 *    retry exhaustion → FAILED.
 *  - REPROCESS returns any terminal/review state to ANALYSIS_PENDING; old
 *    versions stay auditable (is_current/superseded_at semantics).
 *  - There are no implicit edges: every (from, event) pair is listed.
 */
export const LEAD_TRANSITION_TABLE: readonly ProcessingTransition[] = [
  // happy path
  { from: 'DISCOVERED', event: 'RAW_STORED', to: 'RAW_STORED' },
  { from: 'RAW_STORED', event: 'NORMALIZED', to: 'NORMALIZED' },
  { from: 'NORMALIZED', event: 'DEDUP_RESOLVED', to: 'DEDUP_CHECKED' },
  { from: 'DEDUP_CHECKED', event: 'QUEUE_ANALYSIS', to: 'ANALYSIS_PENDING' },
  { from: 'ANALYSIS_PENDING', event: 'ANALYSIS_STARTED', to: 'ANALYZING' },
  { from: 'ANALYZING', event: 'ANALYSIS_SUCCEEDED', to: 'SCORED' },
  { from: 'SCORED', event: 'THRESHOLD_MAP', to: 'QUALIFIED' },
  { from: 'SCORED', event: 'THRESHOLD_MAP', to: 'REVIEW_REQUIRED' },
  { from: 'SCORED', event: 'THRESHOLD_MAP', to: 'REJECTED' },
  // failure paths
  { from: 'ANALYZING', event: 'ANALYSIS_FAILED', to: 'REVIEW_REQUIRED' }, // AI_UNAVAILABLE
  { from: 'ANALYZING', event: 'ANALYSIS_FAILED', to: 'FAILED' }, // retry exhausted
  { from: 'ANALYZING', event: 'RETRY_EXHAUSTED', to: 'FAILED' },
  // human review
  { from: 'REVIEW_REQUIRED', event: 'HUMAN_REVIEWED', to: 'QUALIFIED' },
  { from: 'REVIEW_REQUIRED', event: 'HUMAN_REVIEWED', to: 'REJECTED' },
  // reprocessing / resume
  { from: 'SCORED', event: 'REPROCESS', to: 'ANALYSIS_PENDING' },
  { from: 'REVIEW_REQUIRED', event: 'REPROCESS', to: 'ANALYSIS_PENDING' },
  { from: 'REJECTED', event: 'REPROCESS', to: 'ANALYSIS_PENDING' },
  { from: 'QUALIFIED', event: 'REPROCESS', to: 'ANALYSIS_PENDING' },
  { from: 'FAILED', event: 'REPROCESS', to: 'ANALYSIS_PENDING' },
  // archival
  { from: 'QUALIFIED', event: 'ARCHIVE', to: 'ARCHIVED' },
  { from: 'REVIEW_REQUIRED', event: 'ARCHIVE', to: 'ARCHIVED' },
];

/** Every (from, event) pair must be declared explicitly — no implicit edges. */
export function canTransition(
  table: readonly ProcessingTransition[],
  from: ProcessingStage,
  event: ProcessingEvent,
  to: ProcessingStage,
): boolean {
  return table.some((t) => t.from === from && t.event === event && t.to === to);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface StartPipelineInput {
  tenantId: string;
  leadId: string;
  analysisMode: 'BASIC' | 'STANDARD' | 'DEEP';
  correlationId?: string;
}

export interface Orchestrator {
  /** Creates an ANALYSIS job for the lead and moves it to ANALYSIS_PENDING. */
  startAnalysis(input: StartPipelineInput): Promise<JobRecord>;

  /** Emits a lifecycle event through the transition table; rejects invalid moves. */
  applyLeadEvent(input: {
    leadId: string;
    event: ProcessingEvent;
    expectedFrom: ProcessingStage;
  }): Promise<ProcessingStage>;

  /** Re-enqueues a lead pipeline from its current persisted state. */
  resume(input: { tenantId: string; leadId: string }): Promise<JobRecord>;

  /** Reprocessing: old versions stay auditable; new version becomes current. */
  reprocess(input: StartPipelineInput): Promise<JobRecord>;

  /** Cooperative cancellation: stops at the next step boundary. */
  cancel(jobId: string): Promise<JobRecord>;
}
