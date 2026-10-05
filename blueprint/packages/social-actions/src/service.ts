/**
 * Social Action Service (ADR-026).
 *
 * Executes one tenant-scoped action through an ActionProvider with:
 *  - capability gating (unsupported → NOT_SUPPORTED + manual fallback plan)
 *  - idempotency (same tenant+key replays the original record, no provider call)
 *  - suppression + recent-contact guards (prevents accidental duplicates)
 *  - explicit state transitions (ACTION_TRANSITION_TABLE) with audit entries
 *  - per-attempt records incl. provider retry-after (respected, never evaded)
 */

import type {
  ActionExecutionOutcome,
  ActionProvider,
  ActionTarget,
  AuditEntry,
  AuditSink,
  Clock,
  ContactHistoryEntry,
  ContactHistoryStore,
  ExecuteResult,
  IdGenerator,
  ManualFallbackPlan,
  SocialActionAttempt,
  SocialActionAttemptStore,
  SocialActionRecord,
  SocialActionStore,
  SocialActionType,
  SuppressionChecker,
} from './contracts.ts';
import {
  CAPABILITY_BY_ACTION_TYPE,
  canTransitionAction,
} from './contracts.ts';

export class InvalidTransitionError extends Error {
  readonly from: string;
  readonly event: string;
  readonly to: string;

  constructor(from: string, event: string, to: string) {
    super(`invalid social action transition ${from} --${event}--> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.event = event;
    this.to = to;
  }
}

export class IdempotencyConflictError extends Error {
  readonly tenantId: string;
  readonly idempotencyKey: string;

  constructor(tenantId: string, idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" already used for a different action in tenant`);
    this.name = 'IdempotencyConflictError';
    this.tenantId = tenantId;
    this.idempotencyKey = idempotencyKey;
  }
}

export class InvalidActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActionInputError';
  }
}

export class ActionNotFoundError extends Error {
  readonly tenantId: string;
  readonly actionId: string;

  constructor(tenantId: string, actionId: string) {
    super(`social action "${actionId}" not found in tenant`);
    this.name = 'ActionNotFoundError';
    this.tenantId = tenantId;
    this.actionId = actionId;
  }
}

export interface SocialActionServiceDeps {
  providers: ReadonlyMap<string, ActionProvider>;
  store: SocialActionStore;
  attempts: SocialActionAttemptStore;
  contactHistory: ContactHistoryStore;
  suppression: SuppressionChecker;
  audit: AuditSink;
  clock: Clock;
  ids: IdGenerator;
  /** Cool-down between contacts with the same lead. Default 24h. */
  recentContactWindowHours?: number;
}

export interface ExecuteActionInput {
  tenantId: string;
  actorId: string;
  leadId: string;
  sourceType: string;
  type: SocialActionType;
  target: ActionTarget;
  idempotencyKey: string;
  /** Required for SEND_MESSAGE; rendered by outreach, never assembled ad hoc. */
  message?: string;
  campaignId?: string;
  templateId?: string;
  /** Routes the record to AWAITING_APPROVAL instead of executing immediately. */
  requireApproval?: boolean;
}

const CHANNEL_BY_TYPE = {
  OPEN_PROFILE: 'PROFILE_VISIT',
  FOLLOW_PROFILE: 'FOLLOW',
  UNFOLLOW_PROFILE: 'UNFOLLOW',
  SEND_MESSAGE: 'DIRECT_MESSAGE',
} as const satisfies Record<SocialActionType, 'PROFILE_VISIT' | 'FOLLOW' | 'UNFOLLOW' | 'DIRECT_MESSAGE'>;

/** Fatal provider errors are not retried automatically. */
const FATAL_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'INVALID_REQUEST',
  'NOT_FOUND',
]);

export class SocialActionService {
  private readonly providers: ReadonlyMap<string, ActionProvider>;
  private readonly store: SocialActionStore;
  private readonly attempts: SocialActionAttemptStore;
  private readonly contactHistory: ContactHistoryStore;
  private readonly suppression: SuppressionChecker;
  private readonly audit: AuditSink;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly recentContactWindowHours: number;

  constructor(deps: SocialActionServiceDeps) {
    this.providers = deps.providers;
    this.store = deps.store;
    this.attempts = deps.attempts;
    this.contactHistory = deps.contactHistory;
    this.suppression = deps.suppression;
    this.audit = deps.audit;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.recentContactWindowHours = deps.recentContactWindowHours ?? 24;
  }

  // -- capability reporting (honest; never assumes) -------------------------

  actionCapabilities(sourceType: string): ReadonlySet<string> {
    return this.providers.get(sourceType)?.actionCapabilities() ?? new Set<string>();
  }

  /**
   * Per-action capability report for the UI: only 'SUPPORTED' actions may be
   * rendered as executable. 'BULK_SEND_MESSAGE' is evaluated by @ulip/outreach.
   */
  capabilityReport(sourceType: string): Record<SocialActionType, 'SUPPORTED' | 'NOT_SUPPORTED'> {
    const provider = this.providers.get(sourceType);
    const report = {} as Record<SocialActionType, 'SUPPORTED' | 'NOT_SUPPORTED'>;
    (Object.keys(CAPABILITY_BY_ACTION_TYPE) as SocialActionType[]).forEach((type) => {
      const capability = CAPABILITY_BY_ACTION_TYPE[type];
      report[type] = provider !== undefined && provider.supportsAction(capability)
        ? 'SUPPORTED'
        : 'NOT_SUPPORTED';
    });
    return report;
  }

  // -- manual fallback -------------------------------------------------------

  buildManualFallback(record: SocialActionRecord): ManualFallbackPlan {
    const instructions: string[] = [
      `Open the lead profile on ${record.sourceType}`,
    ];
    if (record.type === 'SEND_MESSAGE') {
      instructions.push('Copy the prepared message');
      instructions.push('Send it manually through the platform');
    } else {
      instructions.push(`Perform the ${record.type.toLowerCase().replaceAll('_', ' ')} action manually`);
    }
    instructions.push('Return here and mark the action as completed manually');

    const plan: ManualFallbackPlan = {
      actionType: record.type,
      sourceType: record.sourceType,
      instructions,
      reason: 'ACTION_CAPABILITY_NOT_SUPPORTED',
    };
    if (record.profileUrl !== undefined) plan.targetProfileUrl = record.profileUrl;
    if (record.renderedMessage !== undefined) plan.preparedMessage = record.renderedMessage;
    return plan;
  }

  // -- execution ------------------------------------------------------------

  async execute(input: ExecuteActionInput): Promise<ExecuteResult> {
    if (input.type === 'SEND_MESSAGE' && (input.message === undefined || input.message === '')) {
      throw new InvalidActionInputError('SEND_MESSAGE requires a rendered message');
    }

    // Idempotency first: same tenant+key always replays the original record.
    const existing = await this.store.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (existing !== null) {
      if (existing.type !== input.type || existing.leadId !== input.leadId) {
        throw new IdempotencyConflictError(input.tenantId, input.idempotencyKey);
      }
      return { kind: 'IDEMPOTENT_REPLAY', action: existing };
    }

    const now = this.clock.now().toISOString();
    const provider = this.providers.get(input.sourceType);
    const capability = CAPABILITY_BY_ACTION_TYPE[input.type];
    const supported = provider !== undefined && provider.supportsAction(capability);

    const record = this.newRecord(input, now);

    if (!supported) {
      // Honest refusal: no provider call, no faked success.
      record.status = 'NOT_SUPPORTED';
      record.errorCode = 'ACTION_CAPABILITY_NOT_SUPPORTED';
      record.errorMessage = `action capability "${capability}" is not supported by source "${input.sourceType}"`;
      await this.persist(record, now);
      await this.appendAttempt(record, 1, 'NOT_SUPPORTED', {
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        startedAt: now,
        finishedAt: now,
      });
      await this.auditAppend(record, 'MARK_UNSUPPORTED', now);
      return { kind: 'NOT_SUPPORTED', action: record, fallback: this.buildManualFallback(record) };
    }

    await this.persist(record, now);
    await this.auditAppend(record, 'CREATED', now);

    if (input.requireApproval === true) {
      await this.apply(record, 'PENDING', 'SUBMIT_FOR_APPROVAL', 'AWAITING_APPROVAL', now);
      await this.auditAppend(record, 'SUBMIT_FOR_APPROVAL', now);
      return { kind: 'AWAITING_APPROVAL', action: record };
    }

    // Guards before any provider call — prevents accidental duplicates.
    const suppressed = await this.suppression.isSuppressed(input.tenantId, input.leadId);
    if (suppressed !== null) {
      return this.block(record, 'SUPPRESSED', suppressed.reason, now);
    }
    const windowStart = new Date(
      this.clock.now().getTime() - this.recentContactWindowHours * 3_600_000,
    ).toISOString();
    const recent = await this.contactHistory.latestWithin(input.tenantId, input.leadId, windowStart);
    if (recent !== null) {
      return this.block(record, 'RECENT_CONTACT', `last contact ${recent.occurredAt}`, now, recent);
    }

    return this.runProviderCall(record, provider, now);
  }

  /** Retries a FAILED action: FAILED → PENDING → EXECUTING (same idempotency key). */
  async retry(tenantId: string, actionId: string, actorId: string): Promise<ExecuteResult> {
    const record = await this.mustFind(tenantId, actionId);
    const now = this.clock.now().toISOString();
    this.requireTransition(record, 'RETRY', 'PENDING', now);
    record.status = 'PENDING';
    record.actorId = actorId;
    await this.store.save(record);
    await this.auditAppend(record, 'RETRY', now);
    const provider = this.providers.get(record.sourceType);
    if (provider === undefined) {
      throw new InvalidActionInputError(`no action provider for source "${record.sourceType}"`);
    }
    return this.runProviderCall(record, provider, this.clock.now().toISOString());
  }

  async approve(tenantId: string, actionId: string, actorId: string): Promise<SocialActionRecord> {
    const record = await this.mustFind(tenantId, actionId);
    const now = this.clock.now().toISOString();
    this.requireTransition(record, 'APPROVE', 'APPROVED', now);
    record.status = 'APPROVED';
    record.actorId = actorId;
    await this.store.save(record);
    await this.auditAppend(record, 'APPROVE', now);
    return record;
  }

  async cancel(tenantId: string, actionId: string, actorId: string): Promise<SocialActionRecord> {
    const record = await this.mustFind(tenantId, actionId);
    const now = this.clock.now().toISOString();
    this.requireTransition(record, 'CANCEL', 'CANCELLED', now);
    record.status = 'CANCELLED';
    record.actorId = actorId;
    await this.store.save(record);
    await this.auditAppend(record, 'CANCEL', now);
    return record;
  }

  /** Moves a NOT_SUPPORTED action into the manual fallback flow. */
  async startManualFallback(
    tenantId: string,
    actionId: string,
    actorId: string,
  ): Promise<SocialActionRecord> {
    const record = await this.mustFind(tenantId, actionId);
    const now = this.clock.now().toISOString();
    this.requireTransition(record, 'FALLBACK', 'MANUAL_FALLBACK', now);
    record.status = 'MANUAL_FALLBACK';
    record.actorId = actorId;
    await this.store.save(record);
    await this.auditAppend(record, 'FALLBACK', now);
    return record;
  }

  /** Closes the manual fallback loop after the user performed the action. */
  async completeManually(
    tenantId: string,
    actionId: string,
    actorId: string,
  ): Promise<ExecuteResult> {
    const record = await this.mustFind(tenantId, actionId);
    const now = this.clock.now().toISOString();
    this.requireTransition(record, 'COMPLETE_MANUAL', 'SUCCEEDED', now);
    record.status = 'SUCCEEDED';
    record.manualCompletedAt = now;
    record.executedAt = now;
    record.updatedAt = now;
    await this.store.save(record);
    await this.appendAttempt(record, await this.nextAttemptNo(tenantId, actionId), 'SUCCESS', {
      startedAt: now,
      finishedAt: now,
      errorMessage: 'completed manually by user',
    });
    await this.recordContact(record, 'MANUAL', now);
    await this.auditAppend(record, 'COMPLETE_MANUAL', now);
    return { kind: 'COMPLETED_MANUALLY', action: record };
  }

  async getAction(tenantId: string, actionId: string): Promise<SocialActionRecord> {
    return this.mustFind(tenantId, actionId);
  }

  listAttempts(tenantId: string, actionId: string): Promise<readonly SocialActionAttempt[]> {
    return this.attempts.listByAction(tenantId, actionId);
  }

  // -- internals ------------------------------------------------------------

  private newRecord(input: ExecuteActionInput, now: string): SocialActionRecord {
    const record: SocialActionRecord = {
      id: this.ids.newId(),
      tenantId: input.tenantId,
      leadId: input.leadId,
      sourceType: input.sourceType,
      type: input.type,
      status: 'PENDING',
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    if (input.target.externalId !== undefined) record.externalId = input.target.externalId;
    if (input.target.profileUrl !== undefined) record.profileUrl = input.target.profileUrl;
    if (input.message !== undefined) record.renderedMessage = input.message;
    if (input.campaignId !== undefined) record.campaignId = input.campaignId;
    if (input.templateId !== undefined) record.templateId = input.templateId;
    return record;
  }

  private async runProviderCall(
    record: SocialActionRecord,
    provider: ActionProvider,
    now: string,
  ): Promise<ExecuteResult> {
    this.requireTransition(record, 'EXECUTE', 'EXECUTING', now);
    record.status = 'EXECUTING';
    const attemptNo = await this.nextAttemptNo(record.tenantId, record.id);
    const startedAt = this.clock.now().toISOString();
    await this.auditAppend(record, 'EXECUTE', startedAt);

    const context = {
      tenantId: record.tenantId,
      actorId: record.actorId,
      idempotencyKey: record.idempotencyKey,
    };
    const target: ActionTarget = { leadId: record.leadId, externalId: record.externalId ?? '' };
    if (record.profileUrl !== undefined) target.profileUrl = record.profileUrl;

    let outcome: ActionExecutionOutcome;
    try {
      outcome = await this.callProvider(record, provider, context, target);
    } catch (err) {
      outcome = {
        status: 'FAILED',
        errorCode: 'UNKNOWN',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    const finishedAt = this.clock.now().toISOString();
    record.updatedAt = finishedAt;

    if (outcome.status === 'SUCCEEDED') {
      this.requireTransition(record, 'SUCCEED', 'SUCCEEDED', finishedAt);
      record.status = 'SUCCEEDED';
      record.executedAt = finishedAt;
      await this.store.save(record);
      await this.appendAttempt(record, attemptNo, 'SUCCESS', {
        providerRef: outcome.providerRef,
        startedAt,
        finishedAt,
      });
      await this.recordContact(record, 'OUTBOUND', finishedAt);
      await this.auditAppend(record, 'SUCCEED', finishedAt);
      return { kind: 'EXECUTED', action: record, provider: outcome };
    }

    if (outcome.status === 'NOT_SUPPORTED') {
      this.requireTransition(record, 'MARK_UNSUPPORTED', 'NOT_SUPPORTED', finishedAt);
      record.status = 'NOT_SUPPORTED';
      record.errorCode = 'ACTION_CAPABILITY_NOT_SUPPORTED';
      if (outcome.errorMessage !== undefined) record.errorMessage = outcome.errorMessage;
      await this.store.save(record);
      await this.appendAttempt(record, attemptNo, 'NOT_SUPPORTED', {
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        startedAt,
        finishedAt,
      });
      await this.auditAppend(record, 'MARK_UNSUPPORTED', finishedAt);
      return { kind: 'NOT_SUPPORTED', action: record, fallback: this.buildManualFallback(record) };
    }

    this.requireTransition(record, 'FAIL', 'FAILED', finishedAt);
    record.status = 'FAILED';
    record.errorCode = outcome.errorCode ?? 'UNKNOWN';
    if (outcome.errorMessage !== undefined) record.errorMessage = outcome.errorMessage;
    await this.store.save(record);
    await this.appendAttempt(
      record,
      attemptNo,
      outcome.errorCode !== undefined && FATAL_PROVIDER_ERRORS.has(outcome.errorCode)
        ? 'FATAL_FAILURE'
        : 'RETRYABLE_FAILURE',
      {
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        retryAfterAt: outcome.retryAfterAt,
        startedAt,
        finishedAt,
      },
    );
    await this.auditAppend(record, 'FAIL', finishedAt);
    return { kind: 'EXECUTED', action: record, provider: outcome };
  }

  private callProvider(
    record: SocialActionRecord,
    provider: ActionProvider,
    context: { tenantId: string; actorId: string; idempotencyKey: string },
    target: ActionTarget,
  ): Promise<ActionExecutionOutcome> {
    switch (record.type) {
      case 'OPEN_PROFILE':
        return provider.openProfile({ context, target });
      case 'FOLLOW_PROFILE':
        return provider.followProfile({ context, target });
      case 'UNFOLLOW_PROFILE':
        return provider.unfollowProfile({ context, target });
      case 'SEND_MESSAGE':
        return provider.sendMessage({ context, target, message: record.renderedMessage ?? '' });
    }
  }

  private async block(
    record: SocialActionRecord,
    code: 'SUPPRESSED' | 'RECENT_CONTACT',
    reason: string,
    now: string,
    recent?: ContactHistoryEntry,
  ): Promise<ExecuteResult> {
    this.requireTransition(record, 'CANCEL', 'CANCELLED', now);
    record.status = 'CANCELLED';
    record.errorCode = code;
    record.errorMessage = reason;
    record.updatedAt = now;
    await this.store.save(record);
    await this.appendAttempt(record, await this.nextAttemptNo(record.tenantId, record.id), 'FATAL_FAILURE', {
      errorCode: code,
      errorMessage: reason,
      startedAt: now,
      finishedAt: now,
    });
    await this.auditAppend(record, 'BLOCKED', now);
    if (code === 'RECENT_CONTACT' && recent !== undefined) {
      return { kind: 'BLOCKED_RECENT_CONTACT', action: record, lastContactAt: recent.occurredAt };
    }
    return { kind: 'BLOCKED_SUPPRESSED', action: record, reason };
  }

  private async apply(
    record: SocialActionRecord,
    expectedFrom: SocialActionRecord['status'],
    event: Parameters<typeof canTransitionAction>[1],
    to: SocialActionRecord['status'],
    now: string,
  ): Promise<void> {
    if (record.status !== expectedFrom || !canTransitionAction(record.status, event, to)) {
      throw new InvalidTransitionError(record.status, event, to);
    }
    record.status = to;
    record.updatedAt = now;
    await this.store.save(record);
  }

  private requireTransition(
    record: SocialActionRecord,
    event: Parameters<typeof canTransitionAction>[1],
    to: SocialActionRecord['status'],
    now: string,
  ): void {
    if (!canTransitionAction(record.status, event, to)) {
      throw new InvalidTransitionError(record.status, event, to);
    }
    record.updatedAt = now;
  }

  private async mustFind(tenantId: string, actionId: string): Promise<SocialActionRecord> {
    const record = await this.store.findById(tenantId, actionId);
    if (record === null) throw new ActionNotFoundError(tenantId, actionId);
    return record;
  }

  private async nextAttemptNo(tenantId: string, actionId: string): Promise<number> {
    const list = await this.attempts.listByAction(tenantId, actionId);
    return list.length + 1;
  }

  private async persist(record: SocialActionRecord, now: string): Promise<void> {
    record.updatedAt = now;
    await this.store.save(record);
  }

  private async appendAttempt(
    record: SocialActionRecord,
    attemptNo: number,
    outcome: SocialActionAttempt['outcome'],
    fields: {
      errorCode?: string | undefined;
      errorMessage?: string | undefined;
      retryAfterAt?: string | undefined;
      providerRef?: string | undefined;
      startedAt: string;
      finishedAt?: string | undefined;
    },
  ): Promise<void> {
    const attempt: SocialActionAttempt = {
      id: this.ids.newId(),
      tenantId: record.tenantId,
      actionId: record.id,
      attemptNo,
      outcome,
      startedAt: fields.startedAt,
    };
    if (fields.errorCode !== undefined) attempt.errorCode = fields.errorCode;
    if (fields.errorMessage !== undefined) attempt.errorMessage = fields.errorMessage;
    if (fields.retryAfterAt !== undefined) attempt.retryAfterAt = fields.retryAfterAt;
    if (fields.providerRef !== undefined) attempt.providerRef = fields.providerRef;
    if (fields.finishedAt !== undefined) attempt.finishedAt = fields.finishedAt;
    await this.attempts.append(attempt);
  }

  private async recordContact(
    record: SocialActionRecord,
    direction: ContactHistoryEntry['direction'],
    now: string,
  ): Promise<void> {
    const entry: ContactHistoryEntry = {
      id: this.ids.newId(),
      tenantId: record.tenantId,
      leadId: record.leadId,
      channel: CHANNEL_BY_TYPE[record.type],
      direction,
      occurredAt: now,
      summary: `${record.type} via ${record.sourceType}${record.campaignId !== undefined ? ' (campaign)' : ''}`,
    };
    if (record.campaignId !== undefined) entry.campaignId = record.campaignId;
    entry.socialActionId = record.id;
    await this.contactHistory.append(entry);
  }

  private auditAppend(record: SocialActionRecord, action: string, now: string): Promise<void> {
    const entry: AuditEntry = {
      tenantId: record.tenantId,
      actorId: record.actorId,
      entityType: 'social_action',
      entityId: record.id,
      action,
      occurredAt: now,
    };
    entry.metadata = {
      type: record.type,
      status: record.status,
      sourceType: record.sourceType,
      leadId: record.leadId,
    };
    return this.audit.append(entry);
  }
}
