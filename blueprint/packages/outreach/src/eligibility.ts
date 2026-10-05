/**
 * Recipient eligibility (ADR-026). Evaluated at selection time from resolved
 * per-lead facts, and re-enforced at execution time by the Social Action
 * service (suppression + cool-down guards) — defense in depth.
 *
 * Default rule: outreach targets QUALIFIED leads only. A lead that is not
 * ready is never messaged, and suppression always wins.
 */

import type { IneligibilityReason, LeadRef } from './contracts.ts';

export interface EligibilityVerdict {
  eligible: boolean;
  reason?: IneligibilityReason;
  detail?: string;
}

export interface EligibilityInput {
  lead: LeadRef;
  actionSupported: boolean;
  coolDownWindowHours: number;
  nowIso: string;
  eligibleStatuses?: readonly LeadRef['status'][];
}

const DEFAULT_ELIGIBLE_STATUSES: readonly LeadRef['status'][] = ['QUALIFIED'];

export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  const { lead } = input;

  if (lead.suppressed !== undefined) {
    return { eligible: false, reason: 'SUPPRESSED', detail: lead.suppressed.reason };
  }

  if (lead.lastContactAt !== undefined) {
    const windowMs = input.coolDownWindowHours * 3_600_000;
    const last = Date.parse(lead.lastContactAt);
    const now = Date.parse(input.nowIso);
    if (!Number.isNaN(last) && !Number.isNaN(now) && now - last < windowMs) {
      return { eligible: false, reason: 'RECENT_CONTACT', detail: `last contact ${lead.lastContactAt}` };
    }
  }

  if (lead.externalId === undefined || lead.externalId === '') {
    return { eligible: false, reason: 'MISSING_IDENTITY', detail: 'no source identity to address' };
  }

  if (!input.actionSupported) {
    return { eligible: false, reason: 'ACTION_NOT_SUPPORTED', detail: `source ${lead.sourceType} cannot send messages` };
  }

  const statuses = input.eligibleStatuses ?? DEFAULT_ELIGIBLE_STATUSES;
  if (!statuses.includes(lead.status)) {
    return { eligible: false, reason: 'LEAD_NOT_READY', detail: `status ${lead.status}` };
  }

  return { eligible: true };
}
