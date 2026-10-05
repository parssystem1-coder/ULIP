/**
 * Outreach contracts (ADR-026).
 *
 * Outreach = campaign-based, human-approved, per-lead execution of social
 * actions. BULK messaging is ALWAYS one separate message per selected lead —
 * never a group chat. Campaign/outreach filtering preserves the universal
 * business model: Business Type → Industry → Specialty → Sub-specialty +
 * Location.
 */

import type { LeadStatus } from '@ulip/domain/contracts';
import type { Clock, IdGenerator } from '@ulip/social-actions';

export type { Clock, IdGenerator, LeadStatus };

// ---------------------------------------------------------------------------
// Campaign lifecycle (mirrors outreach_campaign_status enum in schema.sql)
// ---------------------------------------------------------------------------

export type CampaignStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED';

export type CampaignEvent =
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'COMPLETE'
  | 'CANCEL';

export interface CampaignTransition {
  from: CampaignStatus;
  event: CampaignEvent;
  to: CampaignStatus;
}

/**
 * Human-approval gate (ADR-026): EXECUTING is reachable ONLY from APPROVED,
 * and APPROVED only through explicit human approval of a previewed plan.
 */
export const CAMPAIGN_TRANSITION_TABLE: readonly CampaignTransition[] = [
  { from: 'DRAFT', event: 'SUBMIT_FOR_APPROVAL', to: 'PENDING_APPROVAL' },
  { from: 'DRAFT', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'PENDING_APPROVAL', event: 'APPROVE', to: 'APPROVED' },
  { from: 'PENDING_APPROVAL', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'APPROVED', event: 'START', to: 'EXECUTING' },
  { from: 'APPROVED', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'EXECUTING', event: 'PAUSE', to: 'PAUSED' },
  { from: 'EXECUTING', event: 'COMPLETE', to: 'COMPLETED' },
  { from: 'EXECUTING', event: 'CANCEL', to: 'CANCELLED' },
  { from: 'PAUSED', event: 'RESUME', to: 'EXECUTING' },
  { from: 'PAUSED', event: 'CANCEL', to: 'CANCELLED' },
  // retry re-run of a completed campaign that still has retryable FAILED recipients
  { from: 'COMPLETED', event: 'RESUME', to: 'EXECUTING' },
];

export function canTransitionCampaign(
  from: CampaignStatus,
  event: CampaignEvent,
  to: CampaignStatus,
): boolean {
  return CAMPAIGN_TRANSITION_TABLE.some((t) => t.from === from && t.event === event && t.to === to);
}

// ---------------------------------------------------------------------------
// Campaign / filters (universal business model is preserved)
// ---------------------------------------------------------------------------

/** Campaign audience filter — the SAME structured fields as lead search. */
export interface CampaignFilters {
  businessTypes?: string[];
  industries?: string[];
  specialties?: string[];
  subSpecialties?: string[];
  city?: string;
  country?: string;
  sourceType?: string;
}

export interface OutreachCampaign {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  filters: CampaignFilters;
  templateId: string;
  status: CampaignStatus;
  jobId?: string;
  approvedBy?: string;
  approvedAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export type TemplateStatus = 'ACTIVE' | 'DISABLED';

export interface MessageTemplate {
  id: string;
  tenantId: string;
  name: string;
  /** Body with `{{variable}}` placeholders; rendered per lead at preview time. */
  body: string;
  variables: readonly string[];
  status: TemplateStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Recipients (one row per (campaign, lead) → one separate message per lead)
// ---------------------------------------------------------------------------

export type RecipientStatus =
  | 'PENDING'
  | 'ELIGIBLE'
  | 'QUEUED'
  | 'SENT'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED';

export type IneligibilityReason =
  | 'SUPPRESSED'
  | 'RECENT_CONTACT'
  | 'MISSING_IDENTITY'
  | 'ACTION_NOT_SUPPORTED'
  | 'LEAD_NOT_READY'
  | 'TEMPLATE_ERROR';

export interface OutreachRecipient {
  id: string;
  tenantId: string;
  campaignId: string;
  leadId: string;
  status: RecipientStatus;
  /** Snapshot of the lead's source identity at selection time. */
  sourceType?: string;
  externalId?: string;
  profileUrl?: string;
  ineligibilityReason?: IneligibilityReason;
  /** Rendered per-lead message; each recipient gets its own copy. */
  renderedMessage?: string;
  socialActionId?: string;
  attempts: number;
  sentAt?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Execution report
// ---------------------------------------------------------------------------

export interface CampaignReport {
  campaignId: string;
  status: CampaignStatus;
  totals: {
    recipients: number;
    eligible: number;
    sent: number;
    failed: number;
    skipped: number;
    cancelled: number;
    pending: number;
  };
  skipReasons: Partial<Record<IneligibilityReason, number>>;
  /** sent / eligible, 0..100 */
  progress: number;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TemplateStore {
  save(template: MessageTemplate): Promise<void>;
  findById(tenantId: string, templateId: string): Promise<MessageTemplate | null>;
  findByName(tenantId: string, name: string): Promise<MessageTemplate | null>;
  list(tenantId: string): Promise<readonly MessageTemplate[]>;
}

export interface CampaignStore {
  save(campaign: OutreachCampaign): Promise<void>;
  findById(tenantId: string, campaignId: string): Promise<OutreachCampaign | null>;
  list(tenantId: string): Promise<readonly OutreachCampaign[]>;
}

export interface RecipientStore {
  save(recipient: OutreachRecipient): Promise<void>;
  findById(tenantId: string, recipientId: string): Promise<OutreachRecipient | null>;
  findByCampaignAndLead(
    tenantId: string,
    campaignId: string,
    leadId: string,
  ): Promise<OutreachRecipient | null>;
  listByCampaign(tenantId: string, campaignId: string): Promise<readonly OutreachRecipient[]>;
}

/**
 * Per-lead facts resolved by the composition layer before eligibility runs.
 * Keeps this package decoupled from the lead repository.
 */
export interface LeadRef {
  leadId: string;
  status: LeadStatus;
  sourceType: string;
  externalId?: string;
  profileUrl?: string;
  displayName?: string;
  /** Suppression hit from the suppression store, if any. */
  suppressed?: { reason: string };
  /** Most recent outbound contact timestamp (ISO), if any. */
  lastContactAt?: string;
}

/** Narrow port to the Social Actions domain (implemented by adapters). */
export interface SocialActionPort {
  /** Whether the source's authorized integration genuinely supports SEND_MESSAGE. */
  supportsMessage(sourceType: string): boolean;
  /** Sends ONE message to ONE lead (never a group). */
  sendOne(input: {
    tenantId: string;
    actorId: string;
    campaignId: string;
    recipientId: string;
    leadId: string;
    sourceType: string;
    externalId: string;
    profileUrl?: string;
    message: string;
    templateId: string;
  }): Promise<{
    status: 'SUCCEEDED' | 'FAILED' | 'NOT_SUPPORTED' | 'BLOCKED_SUPPRESSED' | 'BLOCKED_RECENT_CONTACT';
    actionId?: string;
    errorCode?: string;
    reason?: string;
    lastContactAt?: string;
  }>;
}
