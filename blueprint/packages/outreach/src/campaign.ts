/**
 * Outreach Campaign Service (ADR-026).
 *
 * Flow: Select Leads → Choose Template → Preview → Eligibility Check →
 * Confirm (explicit human approval) → Execute (one separate message per lead)
 * → Progress → Report.
 *
 * Bulk execution is retry-safe (SENT recipients are never re-messaged),
 * idempotent per (campaign, lead), cooperatively cancellable, and runs as a
 * persistent OUTREACH job in the composed application.
 */

import type {
  CampaignReport,
  CampaignStatus,
  Clock,
  IdGenerator,
  LeadRef,
  MessageTemplate,
  OutreachCampaign,
  OutreachRecipient,
  RecipientStore,
  SocialActionPort,
  TemplateStore,
  CampaignStore,
} from './contracts.ts';
import { canTransitionCampaign } from './contracts.ts';
import { evaluateEligibility } from './eligibility.ts';
import { extractPlaceholders, renderTemplate, TemplateRenderError } from './template.ts';

export class CampaignNotFoundError extends Error {
  constructor(tenantId: string, campaignId: string) {
    super(`outreach campaign "${campaignId}" not found in tenant`);
    this.name = 'CampaignNotFoundError';
  }
}

export class TemplateNotFoundError extends Error {
  constructor(tenantId: string, templateId: string) {
    super(`message template "${templateId}" not found in tenant`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateExistsError extends Error {
  constructor(tenantId: string, name: string) {
    super(`message template "${name}" already exists in tenant`);
    this.name = 'TemplateExistsError';
  }
}

export class InvalidCampaignStateError extends Error {
  readonly from: string;
  readonly event: string;

  constructor(from: string, event: string) {
    super(`invalid outreach campaign transition ${from} --${event}--> (declared edges only)`);
    this.name = 'InvalidCampaignStateError';
    this.from = from;
    this.event = event;
  }
}

export class ConfirmationMismatchError extends Error {
  constructor(detail: string) {
    super(`confirmation mismatch: ${detail}`);
    this.name = 'ConfirmationMismatchError';
  }
}

export interface OutreachServiceDeps {
  templates: TemplateStore;
  campaigns: CampaignStore;
  recipients: RecipientStore;
  socialActions: SocialActionPort;
  clock: Clock;
  ids: IdGenerator;
  /** Cool-down between contacts with the same lead. Default 24h. */
  recentContactWindowHours?: number;
  eligibleStatuses?: readonly LeadRef['status'][];
  /** Max execution attempts per recipient across re-runs. Default 2. */
  maxAttemptsPerRecipient?: number;
}

export interface CreateTemplateInput {
  tenantId: string;
  name: string;
  body: string;
  createdBy: string;
}

export interface CreateCampaignInput {
  tenantId: string;
  name: string;
  description?: string;
  templateId: string;
  filters: OutreachCampaign['filters'];
  createdBy: string;
}

export interface ConfirmExecutionInput {
  tenantId: string;
  campaignId: string;
  actorId: string;
  /** Numbers the operator confirmed in the UI; must match the stored plan. */
  expected: { recipients: number; eligible: number };
}

export interface SelectionSummary {
  total: number;
  eligible: number;
  ineligible: number;
  byReason: Partial<Record<string, number>>;
  /** Rendered per-lead previews for the UI confirmation screen. */
  previews: Array<{ leadId: string; eligible: boolean; reason?: string; message?: string }>;
}

export interface ExecuteOptions {
  /** Cooperative stop checked between recipients (job cancellation). */
  shouldContinue?: () => boolean;
}

export class OutreachCampaignService {
  private readonly templates: TemplateStore;
  private readonly campaigns: CampaignStore;
  private readonly recipients: RecipientStore;
  private readonly socialActions: SocialActionPort;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly recentContactWindowHours: number;
  private readonly eligibleStatuses: readonly LeadRef['status'][];
  private readonly maxAttemptsPerRecipient: number;

  constructor(deps: OutreachServiceDeps) {
    this.templates = deps.templates;
    this.campaigns = deps.campaigns;
    this.recipients = deps.recipients;
    this.socialActions = deps.socialActions;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.recentContactWindowHours = deps.recentContactWindowHours ?? 24;
    this.eligibleStatuses = deps.eligibleStatuses ?? ['QUALIFIED'];
    this.maxAttemptsPerRecipient = deps.maxAttemptsPerRecipient ?? 2;
  }

  // -- templates -------------------------------------------------------------

  async createTemplate(input: CreateTemplateInput): Promise<MessageTemplate> {
    if (input.body.trim() === '') throw new TemplateRenderError(['EMPTY_BODY']);
    const existing = await this.templates.findByName(input.tenantId, input.name);
    if (existing !== null) throw new TemplateExistsError(input.tenantId, input.name);
    const now = this.clock.now().toISOString();
    const template: MessageTemplate = {
      id: this.ids.newId(),
      tenantId: input.tenantId,
      name: input.name,
      body: input.body,
      variables: extractPlaceholders(input.body),
      status: 'ACTIVE',
      version: 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.templates.save(template);
    return template;
  }

  async getTemplate(tenantId: string, templateId: string): Promise<MessageTemplate> {
    const template = await this.templates.findById(tenantId, templateId);
    if (template === null) throw new TemplateNotFoundError(tenantId, templateId);
    return template;
  }

  listTemplates(tenantId: string): Promise<readonly MessageTemplate[]> {
    return this.templates.list(tenantId);
  }

  /** Backing for the message-preview endpoint (no state change). */
  async renderPreview(
    tenantId: string,
    templateId: string,
    variables: Readonly<Record<string, string>>,
  ): Promise<string> {
    const template = await this.getTemplate(tenantId, templateId);
    if (template.status !== 'ACTIVE') {
      throw new TemplateNotFoundError(tenantId, templateId);
    }
    return renderTemplate(template.body, variables);
  }

  // -- campaign lifecycle ----------------------------------------------------

  async createCampaign(input: CreateCampaignInput): Promise<OutreachCampaign> {
    await this.getTemplate(input.tenantId, input.templateId); // must exist
    const now = this.clock.now().toISOString();
    const campaign: OutreachCampaign = {
      id: this.ids.newId(),
      tenantId: input.tenantId,
      name: input.name,
      filters: input.filters,
      templateId: input.templateId,
      status: 'DRAFT',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    if (input.description !== undefined) campaign.description = input.description;
    await this.campaigns.save(campaign);
    return campaign;
  }

  async getCampaign(tenantId: string, campaignId: string): Promise<OutreachCampaign> {
    const campaign = await this.campaigns.findById(tenantId, campaignId);
    if (campaign === null) throw new CampaignNotFoundError(tenantId, campaignId);
    return campaign;
  }

  listCampaigns(tenantId: string): Promise<readonly OutreachCampaign[]> {
    return this.campaigns.list(tenantId);
  }

  // -- selection + eligibility -----------------------------------------------

  /**
   * Selects leads for a campaign and evaluates eligibility per lead. Every
   * recipient row holds ITS OWN rendered message: bulk messaging is one
   * separate message per selected lead, never a group chat.
   * Retry-safe: a recipient already SENT is never downgraded or re-rendered.
   */
  async selectRecipients(
    tenantId: string,
    campaignId: string,
    actorId: string,
    leads: readonly (LeadRef & { variables?: Readonly<Record<string, string>> })[],
  ): Promise<SelectionSummary> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_APPROVAL') {
      throw new InvalidCampaignStateError(campaign.status, 'SELECT_RECIPIENTS');
    }
    const template = await this.getTemplate(tenantId, campaign.templateId);
    const nowIso = this.clock.now().toISOString();

    const previews: SelectionSummary['previews'] = [];
    const byReason: Partial<Record<string, number>> = {};
    let eligibleCount = 0;

    for (const lead of leads) {
      const actionSupported = this.socialActions.supportsMessage(lead.sourceType);
      const verdict = evaluateEligibility({
        lead,
        actionSupported,
        coolDownWindowHours: this.recentContactWindowHours,
        nowIso,
        eligibleStatuses: this.eligibleStatuses,
      });

      let rendered: string | undefined;
      if (verdict.eligible) {
        try {
          const variables = lead.variables ?? {};
          rendered = renderTemplate(template.body, variables);
        } catch (err) {
          if (err instanceof TemplateRenderError) {
            verdict.eligible = false;
            verdict.reason = 'TEMPLATE_ERROR';
            verdict.detail = err.message;
          } else {
            throw err;
          }
        }
      }

      const existing = await this.recipients.findByCampaignAndLead(tenantId, campaignId, lead.leadId);
      if (existing !== null && existing.status === 'SENT') {
        // Retry-safety: already messaged in this campaign — leave untouched.
        previews.push({ leadId: lead.leadId, eligible: false, reason: 'RECENT_CONTACT' });
        continue;
      }

      const now = nowIso;
      const recipient: OutreachRecipient = existing ?? {
        id: this.ids.newId(),
        tenantId,
        campaignId,
        leadId: lead.leadId,
        status: 'PENDING',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      recipient.sourceType = lead.sourceType;
      if (lead.externalId !== undefined) recipient.externalId = lead.externalId;
      if (lead.profileUrl !== undefined) recipient.profileUrl = lead.profileUrl;
      if (verdict.eligible) {
        recipient.status = 'ELIGIBLE';
        if (rendered !== undefined) recipient.renderedMessage = rendered;
        eligibleCount += 1;
      } else {
        recipient.status = 'SKIPPED';
        if (verdict.reason !== undefined) recipient.ineligibilityReason = verdict.reason;
        if (verdict.detail !== undefined) recipient.failureCode = verdict.detail;
        const reasonKey = verdict.reason ?? 'UNKNOWN';
        byReason[reasonKey] = (byReason[reasonKey] ?? 0) + 1;
      }
      recipient.updatedAt = now;
      await this.recipients.save(recipient);

      const preview: SelectionSummary['previews'][number] = {
        leadId: lead.leadId,
        eligible: verdict.eligible,
      };
      if (verdict.reason !== undefined) preview.reason = verdict.reason;
      if (rendered !== undefined) preview.message = rendered;
      previews.push(preview);
    }

    return { total: leads.length, eligible: eligibleCount, ineligible: leads.length - eligibleCount, byReason, previews };
  }

  // -- confirmation gate -------------------------------------------------------

  /** DRAFT → PENDING_APPROVAL. Requires at least one eligible recipient. */
  async submitForApproval(tenantId: string, campaignId: string, actorId: string): Promise<OutreachCampaign> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    const recipients = await this.recipients.listByCampaign(tenantId, campaignId);
    const eligible = recipients.filter((r) => r.status === 'ELIGIBLE').length;
    if (eligible === 0) {
      throw new ConfirmationMismatchError('campaign has no eligible recipients to confirm');
    }
    return this.transition(campaign, 'SUBMIT_FOR_APPROVAL', 'PENDING_APPROVAL', { actorId });
  }

  /**
   * THE explicit human confirmation. PENDING_APPROVAL → APPROVED. The operator
   * confirms the exact previewed numbers; any drift since preview is a 409.
   */
  async confirmExecution(input: ConfirmExecutionInput): Promise<OutreachCampaign> {
    const campaign = await this.getCampaign(input.tenantId, input.campaignId);
    const recipients = await this.recipients.listByCampaign(input.tenantId, input.campaignId);
    const eligible = recipients.filter((r) => r.status === 'ELIGIBLE').length;
    if (eligible !== input.expected.eligible || recipients.length !== input.expected.recipients) {
      throw new ConfirmationMismatchError(
        `stored plan is ${recipients.length} recipients / ${eligible} eligible, confirmation said ${input.expected.recipients} / ${input.expected.eligible}`,
      );
    }
    return this.transition(campaign, 'APPROVE', 'APPROVED', {
      actorId: input.actorId,
      approvedAt: this.clock.now().toISOString(),
    });
  }

  // -- bulk execution -----------------------------------------------------------

  /**
   * Executes the confirmed campaign: ONE separate message per selected lead.
   * Idempotent and retry-safe — SENT recipients are skipped on re-runs; FAILED
   * ones are retried up to maxAttemptsPerRecipient. Cooperative cancellation
   * between recipients. Default bulk execution requires prior confirmation:
   * only APPROVED campaigns can start.
   */
  async executeBulk(
    tenantId: string,
    campaignId: string,
    actorId: string,
    options: ExecuteOptions = {},
  ): Promise<CampaignReport> {
    let campaign = await this.getCampaign(tenantId, campaignId);
    const existing = await this.recipients.listByCampaign(tenantId, campaignId);
    const hasActionable = existing.some(
      (r) => r.status === 'ELIGIBLE' || (r.status === 'FAILED' && r.attempts < this.maxAttemptsPerRecipient),
    );
    if (campaign.status === 'PAUSED') {
      campaign = await this.transition(campaign, 'RESUME', 'EXECUTING', { actorId });
    } else if (campaign.status === 'APPROVED') {
      campaign = await this.transition(campaign, 'START', 'EXECUTING', { actorId, startedAt: this.clock.now().toISOString() });
    } else if (campaign.status === 'COMPLETED') {
      if (!hasActionable) return this.report(tenantId, campaignId); // idempotent re-run
      campaign = await this.transition(campaign, 'RESUME', 'EXECUTING', { actorId }); // retry re-run
    } else if (campaign.status !== 'EXECUTING') {
      throw new InvalidCampaignStateError(campaign.status, 'START');
    }

    const recipients = await this.recipients.listByCampaign(tenantId, campaignId);
    const actionable = recipients.filter(
      (r) => r.status === 'ELIGIBLE' || (r.status === 'FAILED' && r.attempts < this.maxAttemptsPerRecipient),
    );

    let ranToCompletion = true;
    for (const recipient of actionable) {
      const current = await this.getCampaign(tenantId, campaignId); // cooperative cancel
      if (current.status !== 'EXECUTING') {
        ranToCompletion = false;
        break;
      }
      if (options.shouldContinue?.() === false) {
        ranToCompletion = false;
        break;
      }

      if (recipient.renderedMessage === undefined) {
        recipient.status = 'SKIPPED';
        recipient.ineligibilityReason = 'TEMPLATE_ERROR';
        recipient.updatedAt = this.clock.now().toISOString();
        await this.recipients.save(recipient);
        continue;
      }

      recipient.status = 'QUEUED';
      recipient.updatedAt = this.clock.now().toISOString();
      await this.recipients.save(recipient);

      const result = await this.socialActions.sendOne({
        tenantId,
        actorId,
        campaignId,
        recipientId: recipient.id,
        leadId: recipient.leadId,
        sourceType: recipient.sourceType ?? '',
        externalId: recipient.externalId ?? recipient.leadId,
        message: recipient.renderedMessage,
        templateId: campaign.templateId,
      });

      const now = this.clock.now().toISOString();
      recipient.attempts += 1;
      recipient.updatedAt = now;
      switch (result.status) {
        case 'SUCCEEDED':
          recipient.status = 'SENT';
          recipient.sentAt = now;
          if (result.actionId !== undefined) recipient.socialActionId = result.actionId;
          break;
        case 'BLOCKED_SUPPRESSED':
        case 'BLOCKED_RECENT_CONTACT':
        case 'NOT_SUPPORTED':
          recipient.status = 'SKIPPED';
          recipient.ineligibilityReason =
            result.status === 'BLOCKED_SUPPRESSED' ? 'SUPPRESSED'
            : result.status === 'BLOCKED_RECENT_CONTACT' ? 'RECENT_CONTACT'
            : 'ACTION_NOT_SUPPORTED';
          if (result.reason !== undefined) recipient.failureCode = result.reason;
          break;
        case 'FAILED':
        default:
          recipient.status = 'FAILED';
          if (result.errorCode !== undefined) recipient.failureCode = result.errorCode;
          break;
      }
      await this.recipients.save(recipient);
    }

    campaign = await this.getCampaign(tenantId, campaignId);
    if (ranToCompletion && campaign.status === 'EXECUTING') {
      campaign = await this.transition(campaign, 'COMPLETE', 'COMPLETED', { completedAt: this.clock.now().toISOString() });
    }
    return this.report(tenantId, campaignId);
  }

  async pause(tenantId: string, campaignId: string, actorId: string): Promise<OutreachCampaign> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    return this.transition(campaign, 'PAUSE', 'PAUSED', { actorId });
  }

  async cancel(tenantId: string, campaignId: string, actorId: string, reason?: string): Promise<OutreachCampaign> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    const fields: Parameters<OutreachCampaignService['transition']>[3] = {
      actorId,
      cancelledAt: this.clock.now().toISOString(),
    };
    if (reason !== undefined) fields.cancelReason = reason;
    const cancelled = await this.transition(campaign, 'CANCEL', 'CANCELLED', fields);
    // Pending work is cancelled with the campaign; SENT/FAILED stay auditable.
    const recipients = await this.recipients.listByCampaign(tenantId, campaignId);
    const now = this.clock.now().toISOString();
    for (const recipient of recipients) {
      if (recipient.status === 'PENDING' || recipient.status === 'ELIGIBLE' || recipient.status === 'QUEUED') {
        recipient.status = 'CANCELLED';
        recipient.updatedAt = now;
        await this.recipients.save(recipient);
      }
    }
    return cancelled;
  }

  // -- reporting -------------------------------------------------------------

  async report(tenantId: string, campaignId: string): Promise<CampaignReport> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    const recipients = await this.recipients.listByCampaign(tenantId, campaignId);
    const totals = {
      recipients: recipients.length,
      eligible: recipients.filter((r) => r.status === 'ELIGIBLE' || r.status === 'QUEUED').length,
      sent: recipients.filter((r) => r.status === 'SENT').length,
      failed: recipients.filter((r) => r.status === 'FAILED').length,
      skipped: recipients.filter((r) => r.status === 'SKIPPED').length,
      cancelled: recipients.filter((r) => r.status === 'CANCELLED').length,
      pending: recipients.filter((r) => r.status === 'PENDING').length,
    };
    const skipReasons: CampaignReport['skipReasons'] = {};
    for (const r of recipients) {
      if (r.status === 'SKIPPED' && r.ineligibilityReason !== undefined) {
        skipReasons[r.ineligibilityReason] = (skipReasons[r.ineligibilityReason] ?? 0) + 1;
      }
    }
    const denominated = totals.sent + totals.failed + totals.skipped + totals.cancelled;
    return {
      campaignId,
      status: campaign.status,
      totals,
      skipReasons,
      progress: denominated === 0 ? 0 : Math.round((totals.sent / denominated) * 100),
    };
  }

  // -- internals -------------------------------------------------------------

  private async transition(
    campaign: OutreachCampaign,
    event: Parameters<typeof canTransitionCampaign>[1],
    to: CampaignStatus,
    fields: {
      actorId?: string;
      approvedAt?: string;
      startedAt?: string;
      completedAt?: string;
      cancelledAt?: string;
      cancelReason?: string;
    },
  ): Promise<OutreachCampaign> {
    if (!canTransitionCampaign(campaign.status, event, to)) {
      throw new InvalidCampaignStateError(campaign.status, event);
    }
    campaign.status = to;
    campaign.updatedAt = this.clock.now().toISOString();
    if (fields.actorId !== undefined) campaign.approvedBy = fields.actorId;
    if (fields.approvedAt !== undefined) campaign.approvedAt = fields.approvedAt;
    if (fields.startedAt !== undefined) campaign.startedAt = fields.startedAt;
    if (fields.completedAt !== undefined) campaign.completedAt = fields.completedAt;
    if (fields.cancelledAt !== undefined) campaign.cancelledAt = fields.cancelledAt;
    if (fields.cancelReason !== undefined) campaign.cancelReason = fields.cancelReason;
    await this.campaigns.save(campaign);
    return campaign;
  }

}
