/**
 * In-memory fakes for outreach tests and local composition.
 * FakeSocialActionPort records one send per (campaign, lead) — the automated
 * proof that bulk messaging is one separate message per lead.
 */

import type {
  Clock,
  CampaignStore,
  IdGenerator,
  MessageTemplate,
  OutreachCampaign,
  OutreachRecipient,
  RecipientStore,
  SocialActionPort,
  TemplateStore,
} from './contracts.ts';

export interface FakePortOptions {
  /** Whether the fake source genuinely supports SEND_MESSAGE. */
  supported?: boolean;
  /** Outcome per send call, consumed in order; last repeats. */
  script?: Array<{
    status: 'SUCCEEDED' | 'FAILED' | 'NOT_SUPPORTED' | 'BLOCKED_SUPPRESSED' | 'BLOCKED_RECENT_CONTACT';
    errorCode?: string;
    reason?: string;
  }>;
}

export class FakeSocialActionPort implements SocialActionPort {
  readonly sends: Array<{ tenantId: string; campaignId: string; leadId: string; message: string }> = [];
  private readonly options: FakePortOptions;
  private scriptIndex = 0;

  constructor(options: FakePortOptions = {}) {
    this.options = options;
  }

  setScript(script: NonNullable<FakePortOptions['script']>): void {
    this.options.script = script;
    this.scriptIndex = 0;
  }

  supportsMessage(_sourceType: string): boolean {
    return this.options.supported ?? true;
  }

  async sendOne(input: {
    tenantId: string;
    campaignId: string;
    leadId: string;
    message: string;
  }): Promise<{
    status: 'SUCCEEDED' | 'FAILED' | 'NOT_SUPPORTED' | 'BLOCKED_SUPPRESSED' | 'BLOCKED_RECENT_CONTACT';
    actionId?: string;
    errorCode?: string;
    reason?: string;
  }> {
    this.sends.push({
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      leadId: input.leadId,
      message: input.message,
    });
    const script = this.options.script;
    if (script === undefined || script.length === 0) {
      return { status: 'SUCCEEDED', actionId: `action-${this.sends.length}` };
    }
    const index = Math.min(this.scriptIndex, script.length - 1);
    this.scriptIndex += 1;
    const item = script[index];
    return item ?? { status: 'SUCCEEDED', actionId: `action-${this.sends.length}` };
  }
}

export class InMemoryTemplateStore implements TemplateStore {
  readonly rows = new Map<string, MessageTemplate>();

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  async save(template: MessageTemplate): Promise<void> {
    this.rows.set(this.key(template.tenantId, template.id), { ...template });
  }

  async findById(tenantId: string, templateId: string): Promise<MessageTemplate | null> {
    const row = this.rows.get(this.key(tenantId, templateId));
    return row === undefined ? null : { ...row };
  }

  async findByName(tenantId: string, name: string): Promise<MessageTemplate | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.name === name) return { ...row };
    }
    return null;
  }

  async list(tenantId: string): Promise<readonly MessageTemplate[]> {
    return [...this.rows.values()].filter((t) => t.tenantId === tenantId);
  }
}

export class InMemoryCampaignStore implements CampaignStore {
  readonly rows = new Map<string, OutreachCampaign>();

  async save(campaign: OutreachCampaign): Promise<void> {
    this.rows.set(`${campaign.tenantId}:${campaign.id}`, { ...campaign });
  }

  async findById(tenantId: string, campaignId: string): Promise<OutreachCampaign | null> {
    const row = this.rows.get(`${tenantId}:${campaignId}`);
    return row === undefined ? null : { ...row };
  }

  async list(tenantId: string): Promise<readonly OutreachCampaign[]> {
    return [...this.rows.values()].filter((c) => c.tenantId === tenantId);
  }
}

export class InMemoryRecipientStore implements RecipientStore {
  readonly rows = new Map<string, OutreachRecipient>();

  async save(recipient: OutreachRecipient): Promise<void> {
    this.rows.set(`${recipient.tenantId}:${recipient.id}`, { ...recipient });
  }

  async findById(tenantId: string, recipientId: string): Promise<OutreachRecipient | null> {
    const row = this.rows.get(`${tenantId}:${recipientId}`);
    return row === undefined ? null : { ...row };
  }

  async findByCampaignAndLead(
    tenantId: string,
    campaignId: string,
    leadId: string,
  ): Promise<OutreachRecipient | null> {
    for (const row of this.rows.values()) {
      if (
        row.tenantId === tenantId &&
        row.campaignId === campaignId &&
        row.leadId === leadId
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async listByCampaign(tenantId: string, campaignId: string): Promise<readonly OutreachRecipient[]> {
    return [...this.rows.values()].filter(
      (r) => r.tenantId === tenantId && r.campaignId === campaignId,
    );
  }
}

export class OutreachFixedClock implements Clock {
  private current: Date;

  constructor(startIso = '2026-10-05T00:00:00.000Z') {
    this.current = new Date(startIso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 3_600_000);
  }
}

export class OutreachSequentialIds implements IdGenerator {
  private counter = 0;

  newId(): string {
    this.counter += 1;
    return `oid-${String(this.counter).padStart(4, '0')}`;
  }
}
