/**
 * In-memory fakes for automated tests and local API composition.
 * The FakeActionProvider is the ONLY provider used in automated tests; real
 * platform adapters implement ActionProvider outside this package.
 */

import type { ActionCapability } from '@ulip/connectors';
import type {
  ActionExecutionOutcome,
  ActionProvider,
  ActionProviderMetadata,
  AuditEntry,
  AuditSink,
  Clock,
  ContactHistoryEntry,
  ContactHistoryStore,
  IdGenerator,
  MessageActionInput,
  ProfileActionInput,
  SocialActionAttempt,
  SocialActionAttemptStore,
  SocialActionRecord,
  SocialActionStore,
  SuppressionChecker,
  SuppressionHit,
} from './contracts.ts';

export interface FakeProviderOptions {
  sourceType?: string;
  displayName?: string;
  capabilities?: readonly ActionCapability[];
  /** Scripted outcome per call, consumed in order; last one repeats. */
  script?: readonly ActionExecutionOutcome[];
}
export interface ProviderCallLogEntry {
  operation: 'OPEN_PROFILE' | 'FOLLOW_PROFILE' | 'UNFOLLOW_PROFILE' | 'SEND_MESSAGE';
  tenantId: string;
  leadId: string;
  idempotencyKey: string;
  message?: string;
}

/**
 * Deterministic action provider for tests.
 *  - advertises exactly the configured capabilities (default: none)
 *  - records every call for assertions (no call must happen when unsupported)
 *  - remembers SUCCESS outcomes per idempotency key (real providers do not
 *    remember failures), so retries re-execute failed calls.
 */
export class FakeActionProvider implements ActionProvider {
  readonly calls: ProviderCallLogEntry[] = [];
  private readonly options: FakeProviderOptions;
  private readonly successes = new Map<string, ActionExecutionOutcome>();
  private scriptIndex = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  metadata(): ActionProviderMetadata {
    return {
      sourceType: this.options.sourceType ?? 'fake',
      displayName: this.options.displayName ?? 'Fake Action Provider',
      version: '1.0.0',
    };
  }

  actionCapabilities(): ReadonlySet<ActionCapability> {
    return new Set<ActionCapability>(this.options.capabilities ?? []);
  }

  supportsAction(capability: ActionCapability): boolean {
    return this.actionCapabilities().has(capability);
  }

  /** Replaces the scripted outcomes (test convenience). */
  setScript(script: readonly ActionExecutionOutcome[]): void {
    this.options.script = script;
    this.scriptIndex = 0;
  }

  async openProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome> {
    return this.record('OPEN_PROFILE', input);
  }

  async followProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome> {
    return this.record('FOLLOW_PROFILE', input);
  }

  async unfollowProfile(input: ProfileActionInput): Promise<ActionExecutionOutcome> {
    return this.record('UNFOLLOW_PROFILE', input);
  }

  async sendMessage(input: MessageActionInput): Promise<ActionExecutionOutcome> {
    return this.record('SEND_MESSAGE', input, input.message);
  }

  private record(
    operation: ProviderCallLogEntry['operation'],
    input: ProfileActionInput | MessageActionInput,
    message?: string,
  ): ActionExecutionOutcome {
    const entry: ProviderCallLogEntry = {
      operation,
      tenantId: input.context.tenantId,
      leadId: input.target.leadId,
      idempotencyKey: input.context.idempotencyKey,
    };
    if (message !== undefined) entry.message = message;
    this.calls.push(entry);

    const replay = this.successes.get(input.context.idempotencyKey);
    if (replay !== undefined) return replay;

    const scripted = this.options.script;
    let outcome: ActionExecutionOutcome = { status: 'SUCCEEDED', providerRef: `ref-${this.calls.length}` };
    if (scripted !== undefined && scripted.length > 0) {
      const index = Math.min(this.scriptIndex, scripted.length - 1);
      const item = scripted[index];
      this.scriptIndex += 1;
      if (item !== undefined) outcome = item;
    }
    if (outcome.status === 'SUCCEEDED') {
      this.successes.set(input.context.idempotencyKey, outcome);
    }
    return outcome;
  }
}

export class InMemorySocialActionStore implements SocialActionStore {
  readonly rows = new Map<string, SocialActionRecord>();

  async save(action: SocialActionRecord): Promise<void> {
    this.rows.set(`${action.tenantId}:${action.id}`, { ...action });
  }

  async findById(tenantId: string, actionId: string): Promise<SocialActionRecord | null> {
    const row = this.rows.get(`${tenantId}:${actionId}`);
    return row === undefined ? null : { ...row };
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<SocialActionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.tenantId === tenantId && row.idempotencyKey === idempotencyKey) return { ...row };
    }
    return null;
  }
}

export class InMemoryAttemptStore implements SocialActionAttemptStore {
  readonly rows: SocialActionAttempt[] = [];

  async append(attempt: SocialActionAttempt): Promise<void> {
    this.rows.push({ ...attempt });
  }

  async listByAction(tenantId: string, actionId: string): Promise<readonly SocialActionAttempt[]> {
    return this.rows.filter((a) => a.tenantId === tenantId && a.actionId === actionId);
  }
}

export class InMemoryContactHistoryStore implements ContactHistoryStore {
  readonly rows: ContactHistoryEntry[] = [];

  async append(entry: ContactHistoryEntry): Promise<void> {
    this.rows.push({ ...entry });
  }

  async latestWithin(
    tenantId: string,
    leadId: string,
    sinceIso: string,
  ): Promise<ContactHistoryEntry | null> {
    const matches = this.rows
      .filter((e) => e.tenantId === tenantId && e.leadId === leadId && e.occurredAt >= sinceIso)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    return matches[0] ?? null;
  }
}

export class InMemorySuppressionChecker implements SuppressionChecker {
  private readonly hits = new Map<string, SuppressionHit>();

  suppress(tenantId: string, leadId: string, hit: SuppressionHit): void {
    this.hits.set(`${tenantId}:${leadId}`, hit);
  }

  async isSuppressed(tenantId: string, leadId: string): Promise<SuppressionHit | null> {
    return this.hits.get(`${tenantId}:${leadId}`) ?? null;
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

/** Deterministic clock for tests: starts at a fixed instant and only advances
 *  when told to. */
export class FixedClock implements Clock {
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

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix = 'id') {
    this.prefix = prefix;
  }

  newId(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(4, '0')}`;
  }
}
