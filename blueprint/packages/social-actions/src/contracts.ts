/**
 * Social Actions contracts (ADR-026).
 *
 * A Social Action is a tenant-scoped, permission-controlled, auditable,
 * idempotent, retry-safe mutation performed against a lead's platform profile
 * (open / follow / unfollow / message). This domain is deliberately separate
 * from Lead Discovery and AI Analysis.
 *
 * Core honesty rule: an action capability is executed ONLY when the action
 * provider for the lead's source genuinely advertises it. Anything else yields
 * NOT_SUPPORTED plus a manual fallback plan (open profile → copy prepared
 * message → user performs the action manually). No anti-bypass behavior
 * (CAPTCHA/anti-bot/rate-limit evasion, cookie/session theft) belongs here.
 */

import type { ActionCapability } from '@ulip/connectors';

export type { ActionCapability };

// ---------------------------------------------------------------------------
// Action types and lifecycle (mirrors social_action_type / _status enums in
// database/schema/schema.sql — any change must propagate, see ADR-024).
// ---------------------------------------------------------------------------

/** Concrete, individually-executed mutations. BULK_SEND_MESSAGE is an
 *  orchestration over SEND_MESSAGE (one separate message per selected lead —
 *  never a group chat) and lives in @ulip/outreach, not here. */
export type SocialActionType =
  | 'OPEN_PROFILE'
  | 'FOLLOW_PROFILE'
  | 'UNFOLLOW_PROFILE'
  | 'SEND_MESSAGE';

export const ACTION_TYPE_BY_CAPABILITY: Readonly<
  Record<'OPEN_PROFILE' | 'FOLLOW_PROFILE' | 'UNFOLLOW_PROFILE' | 'SEND_MESSAGE', SocialActionType>
> = {
  OPEN_PROFILE: 'OPEN_PROFILE',
  FOLLOW_PROFILE: 'FOLLOW_PROFILE',
  UNFOLLOW_PROFILE: 'UNFOLLOW_PROFILE',
  SEND_MESSAGE: 'SEND_MESSAGE',
};

export const CAPABILITY_BY_ACTION_TYPE: Readonly<
  Record<SocialActionType, Exclude<ActionCapability, 'BULK_SEND_MESSAGE'>>
> = {
  OPEN_PROFILE: 'OPEN_PROFILE',
  FOLLOW_PROFILE: 'FOLLOW_PROFILE',
  UNFOLLOW_PROFILE: 'UNFOLLOW_PROFILE',
  SEND_MESSAGE: 'SEND_MESSAGE',
};

export type SocialActionStatus =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'NOT_SUPPORTED'
  | 'MANUAL_FALLBACK';

export type SocialActionEvent =
  | 'SUBMIT_FOR_APPROVAL'
  | 'EXECUTE'
  | 'APPROVE'
  | 'SUCCEED'
  | 'FAIL'
  | 'MARK_UNSUPPORTED'
  | 'FALLBACK'
  | 'CANCEL'
  | 'RETRY'
  | 'COMPLETE_MANUAL';

export interface SocialActionTransition {
  from: SocialActionStatus;
  event: SocialActionEvent;
  to: SocialActionStatus;
}

/**
 * Canonical action state transition table. No implicit edges: every
 * (from, event) pair must be declared. Terminal states are SUCCEEDED,
 * CANCELLED and NOT_SUPPORTED-without-fallback.
 */
export const ACTION_TRANSITION_TABLE: readonly SocialActionTransition[] = [
  { from: 'PENDING', event: 'SUBMIT_FOR_APPROVAL', to: 'AWAITING_APPROVAL' },
  { from: 'PENDING', event: 'EXECUTE', to: 'EXECUTING' },
  { from: 'PENDING', event: 'MARK_UNSUPPORTED', to: 'NOT_SUPPORTED' },
  { from: 'PENDING', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'AWAITING_APPROVAL', event: 'APPROVE', to: 'APPROVED' },
  { from: 'AWAITING_APPROVAL', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'APPROVED', event: 'EXECUTE', to: 'EXECUTING' },
  { from: 'APPROVED', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'EXECUTING', event: 'SUCCEED', to: 'SUCCEEDED' },
  { from: 'EXECUTING', event: 'FAIL', to: 'FAILED' },
  { from: 'EXECUTING', event: 'MARK_UNSUPPORTED', to: 'NOT_SUPPORTED' },
  { from: 'EXECUTING', event: 'FALLBACK', to: 'MANUAL_FALLBACK' },
  { from: 'FAILED', event: 'RETRY', to: 'PENDING' },
  { from: 'NOT_SUPPORTED', event: 'FALLBACK', to: 'MANUAL_FALLBACK' },
  { from: 'MANUAL_FALLBACK', event: 'COMPLETE_MANUAL', to: 'SUCCEEDED' },
];

export function canTransitionAction(
  from: SocialActionStatus,
  event: SocialActionEvent,
  to: SocialActionStatus,
): boolean {
  return ACTION_TRANSITION_TABLE.some((t) => t.from === from && t.event === event && t.to === to);
}

/** The single persistent record for one action intent. */
export interface SocialActionRecord {
  id: string;
  tenantId: string;
  leadId: string;
  sourceType: string;
  type: SocialActionType;
  status: SocialActionStatus;
  /** Unique per (tenant, key); replays never re-execute. */
  idempotencyKey: string;
  externalId?: string;
  profileUrl?: string;
  /** Rendered DM content for SEND_MESSAGE (sensitive: store per retention policy). */
  renderedMessage?: string;
  campaignId?: string;
  templateId?: string;
  actorId: string;
  errorCode?: string;
  errorMessage?: string;
  executedAt?: string;
  manualCompletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One provider call against an action. Mirrors social_action_attempts. */
export interface SocialActionAttempt {
  id: string;
  tenantId: string;
  actionId: string;
  attemptNo: number;
  outcome: 'SUCCESS' | 'RETRYABLE_FAILURE' | 'FATAL_FAILURE' | 'NOT_SUPPORTED';
  errorCode?: string;
  errorMessage?: string;
  /** Provider retry-after hint; respected, never evaded. */
  retryAfterAt?: string;
  providerRef?: string;
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Provider port (implemented by platform adapters; faked in tests)
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export interface ActionProviderMetadata {
  sourceType: string;
  displayName: string;
  version: string;
}

/** Tenant/actor context threaded into every provider call for audit. */
export interface ActionCallContext {
  tenantId: string;
  actorId: string;
  /** Provider-side idempotency token (same key + replayed call → same result). */
  idempotencyKey: string;
}

export interface ActionTarget {
  leadId: string;
  externalId: string;
  profileUrl?: string;
}

export interface ProfileActionInput {
  context: ActionCallContext;
  target: ActionTarget;
}

export interface MessageActionInput {
  context: ActionCallContext;
  target: ActionTarget;
  message: string;
}

export interface ActionExecutionOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'NOT_SUPPORTED';
  providerRef?: string;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  /** ISO timestamp after which the provider permits a retry. */
  retryAfterAt?: string;
}

/**
 * A provider performs actions ONLY for capabilities it genuinely supports.
 * It must return status NOT_SUPPORTED instead of throwing for unsupported
 * operations, and must surface provider rate-limit responses via
 * retryAfterAt — respecting, never circumventing, provider restrictions.
 */
export interface ActionProvider {
  metadata(): ActionProviderMetadata;
  actionCapabilities(): ReadonlySet<ActionCapability>;
  supportsAction(capability: ActionCapability): boolean;
  openProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome>;
  followProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome>;
  unfollowProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome>;
  sendMessage(input: MessageActionInput): Promise<ActionExecutionOutcome>;
}

// ---------------------------------------------------------------------------
// Manual fallback (ADR-026): when a capability is not supported the platform
// never fakes success. The user performs the action manually.
// ---------------------------------------------------------------------------

export interface ManualFallbackPlan {
  actionType: SocialActionType;
  sourceType: string;
  targetProfileUrl?: string;
  preparedMessage?: string;
  instructions: readonly string[];
  reason: 'ACTION_CAPABILITY_NOT_SUPPORTED';
}

// ---------------------------------------------------------------------------
// Service result
// ---------------------------------------------------------------------------

export type ExecuteResult =
  | { kind: 'EXECUTED'; action: SocialActionRecord; provider: ActionExecutionOutcome }
  | { kind: 'NOT_SUPPORTED'; action: SocialActionRecord; fallback: ManualFallbackPlan }
  | { kind: 'IDEMPOTENT_REPLAY'; action: SocialActionRecord }
  | { kind: 'BLOCKED_SUPPRESSED'; action: SocialActionRecord; reason: string }
  | { kind: 'BLOCKED_RECENT_CONTACT'; action: SocialActionRecord; lastContactAt: string }
  | { kind: 'AWAITING_APPROVAL'; action: SocialActionRecord }
  | { kind: 'COMPLETED_MANUALLY'; action: SocialActionRecord };

// ---------------------------------------------------------------------------
// Ports (persisted by adapters; in-memory fakes for tests)
// ---------------------------------------------------------------------------

export interface SocialActionStore {
  save(action: SocialActionRecord): Promise<void>;
  findById(tenantId: string, actionId: string): Promise<SocialActionRecord | null>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<SocialActionRecord | null>;
}

export interface SocialActionAttemptStore {
  append(attempt: SocialActionAttempt): Promise<void>;
  listByAction(tenantId: string, actionId: string): Promise<readonly SocialActionAttempt[]>;
}

export type ContactChannel = 'DIRECT_MESSAGE' | 'PROFILE_VISIT' | 'FOLLOW' | 'UNFOLLOW' | 'OTHER';

export interface ContactHistoryEntry {
  id: string;
  tenantId: string;
  leadId: string;
  campaignId?: string;
  socialActionId?: string;
  channel: ContactChannel;
  direction: 'OUTBOUND' | 'MANUAL';
  occurredAt: string;
  summary: string;
}

export interface ContactHistoryStore {
  append(entry: ContactHistoryEntry): Promise<void>;
  /** Most recent contact with this lead inside the window, if any. */
  latestWithin(
    tenantId: string,
    leadId: string,
    sinceIso: string,
  ): Promise<ContactHistoryEntry | null>;
}

export interface SuppressionHit {
  scope: 'LEAD' | 'BUSINESS' | 'EMAIL' | 'PHONE' | 'DOMAIN';
  reason: string;
}

export interface SuppressionChecker {
  isSuppressed(tenantId: string, leadId: string): Promise<SuppressionHit | null>;
}

export interface AuditEntry {
  tenantId: string;
  actorId: string;
  entityType: 'social_action';
  entityId: string;
  action: string;
  metadata?: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}
