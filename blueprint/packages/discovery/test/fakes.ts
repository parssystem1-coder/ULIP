/**
 * Deterministic in-memory fakes for discovery tests (Phase 15).
 * NOT production code — production gets Postgres-backed stores.
 */

import type {
  DiscoveryFlowResult,
  DiscoveryJobPayload,
  EntityResolver,
  NormalizedFields,
  RawEntityStore,
  RawSnapshot,
  SourceLookup,
  SourceRecord,
} from '../src/contracts.ts';
import type { HashtagBudgetStore, HashtagSpendResult } from '../src/hashtag-budget.ts';
import { DeterministicFakeConnectorFactory, runDiscovery } from '../src/index.ts';

export class FakeRawEntityStore implements RawEntityStore {
  readonly rows: {
    sourceId: string;
    externalId: string;
    hash: string;
    payload: Record<string, unknown>;
    collectedAt: string;
  }[] = [];

  private static hash(payload: Record<string, unknown>): string {
    return JSON.stringify(payload);
  }

  async persist(
    source: SourceRecord,
    entity: { sourceType: string; externalId: string; entityType: string; payload: Record<string, unknown>; collectedAt: string },
  ): Promise<RawSnapshot> {
    const h = FakeRawEntityStore.hash(entity.payload);
    const found = this.rows.find((r) => r.sourceId === source.id && r.externalId === entity.externalId && r.hash === h);
    if (found !== undefined) return { id: `${found.externalId}:${found.hash}`, isNewRevision: false };
    this.rows.push({ sourceId: source.id, externalId: entity.externalId, hash: h, payload: { ...entity.payload }, collectedAt: entity.collectedAt });
    return { id: `${entity.externalId}:${h}`, isNewRevision: true };
  }

  async countForSource(): Promise<number> {
    return this.rows.length;
  }
}

export interface FakeLeadRow {
  leadId: string;
  businessId: string;
  tenantId: string;
  displayName: string;
  nameKey: string;
  identityKey: string;
  status: string;
  lastSeenCount: number;
}

let seq = 0;

export class FakeResolver implements EntityResolver {
  readonly leads: FakeLeadRow[] = [];
  /** Deliberate failure injection for retry tests. */
  failNext = false;

  async resolve(tenantId: string, source: SourceRecord, normalized: NormalizedFields): Promise<{ leadId: string; businessId: string; action: 'CREATED' | 'UPDATED' }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('injected resolver failure');
    }
    const identityKey = normalized.username !== undefined && normalized.username !== '' ? `username:${normalized.username}` : normalized.nameKey;
    const existing = this.leads.find((l) => l.tenantId === tenantId && l.identityKey === identityKey);
    if (existing !== undefined) {
      existing.lastSeenCount += 1;
      existing.status = 'ANALYSIS_PENDING';
      return { leadId: existing.leadId, businessId: existing.businessId, action: 'UPDATED' };
    }
    seq += 1;
    const row: FakeLeadRow = {
      leadId: `lead-${seq.toString().padStart(3, '0')}`,
      businessId: `biz-${seq.toString().padStart(3, '0')}`,
      tenantId,
      displayName: normalized.displayName,
      nameKey: normalized.nameKey,
      identityKey,
      status: 'ANALYSIS_PENDING',
      lastSeenCount: 1,
    };
    this.leads.push(row);
    return { leadId: row.leadId, businessId: row.businessId, action: 'CREATED' };
  }
}

export class FakeSources implements SourceLookup {
  private readonly sources: SourceRecord[];

  constructor(sources: SourceRecord[]) {
    this.sources = sources;
  }

  async findById(tenantId: string, sourceId: string): Promise<SourceRecord | null> {
    return this.sources.find((s) => s.tenantId === tenantId && s.id === sourceId) ?? null;
  }
}

export function makeSource(id: string, tenantId: string, type = 'FAKE', config: Record<string, unknown> = {}): SourceRecord {
  return { id, tenantId, type, name: `src-${id}`, status: 'ACTIVE', config };
}

/**
 * In-memory rolling-window hashtag budget (test double for DbHashtagBudgetStore
 * with identical semantics: 30 unique tags / 7d, in-window reuse is free).
 */
export class FakeHashtagBudgetStore implements HashtagBudgetStore {
  readonly ledger = new Map<string, number>(); // key `${tenant}:${source}:${tag}` → last-queried-at ms
  private readonly budget: number;

  constructor(budget = 30) {
    this.budget = budget;
  }

  async spend(input: {
    tenantId: string;
    sourceId: string;
    hashtag: string;
    jobId?: string | undefined;
    budget?: number | undefined;
  }): Promise<HashtagSpendResult> {
    const budget = input.budget ?? this.budget;
    const raw = input.hashtag
      .replace(/[\u200c\u0640\s]+/g, '_')
      .replace(/^#+/, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();
    if (raw === '') return { admitted: false, reused: false, usedInWindow: 0, budget, reason: 'HASHTAG_BUDGET_EXHAUSTED' };
    const key = `${input.tenantId}:${input.sourceId}:${raw}`;
    if (this.ledger.has(key)) {
      const used = this.usedInWindow(input.tenantId, input.sourceId);
      return { admitted: true, reused: true, usedInWindow: used, budget };
    }
    const used = new Set<string>();
    for (const k of this.ledger.keys()) {
      const [t, s, tag] = k.split(':');
      if (t === input.tenantId && s === input.sourceId) used.add(tag ?? '');
    }
    if (used.size >= budget) return { admitted: false, reused: false, usedInWindow: used.size, budget, reason: 'HASHTAG_BUDGET_EXHAUSTED' };
    this.ledger.set(key, Date.now());
    return { admitted: true, reused: false, usedInWindow: used.size + 1, budget };
  }

  async usage(tenantId: string, sourceId: string, budget?: number | undefined): Promise<{ used: number; budget: number; remaining: number }> {
    const used = this.usedInWindow(tenantId, sourceId);
    const b = budget ?? this.budget;
    return { used, budget: b, remaining: Math.max(0, b - used) };
  }

  private usedInWindow(tenantId: string, sourceId: string): number {
    const used = new Set<string>();
    for (const k of this.ledger.keys()) {
      const [t, s, tag] = k.split(':');
      if (t === tenantId && s === sourceId) used.add(tag ?? '');
    }
    return used.size;
  }
}

export function flowSource(id: string, tenantId: string): SourceRecord {
  return makeSource(id, tenantId, 'FAKE');
}

export async function runTestDiscovery(
  deps: {
    sources: SourceLookup;
    rawEntities: RawEntityStore;
    resolver: EntityResolver;
    /** Phase 18 content ingestion (optional; skips when absent). */
    contentIngestor?: import('../src/content.ts').ContentIngestor | undefined;
    /** Phase 21 rolling-7d hashtag budget (optional honest gate). */
    hashtagBudget?: HashtagBudgetStore | undefined;
    log?: { info(msg: string, fields?: Record<string, unknown>): void; error(msg: string, fields?: Record<string, unknown>): void };
  },
  payload: DiscoveryJobPayload | Record<string, unknown>,
  context: { tenantId: string; jobId?: string | undefined; requestId?: string | undefined },
): Promise<DiscoveryFlowResult> {
  const registry = new (await import('../src/index.ts')).ConnectorRegistry();
  registry.register(new DeterministicFakeConnectorFactory());
  const { PersianAwareNormalizer } = await import('../src/index.ts');
  // Test helper: explicitly opts into the deterministic fake (local E2E only),
  // mirroring what the API writes into a real allowFake discovery job payload.
  const withFakeOptIn = { ...(payload as Record<string, unknown>), allowFake: true };
  return runDiscovery(
    {
      log: deps.log ?? { info: () => undefined, error: () => undefined },
      sources: deps.sources,
      rawEntities: deps.rawEntities,
      normalizer: new PersianAwareNormalizer(),
      resolver: deps.resolver,
      connectorRegistry: registry,
      ...(deps.contentIngestor !== undefined ? { contentIngestor: deps.contentIngestor } : {}),
      ...(deps.hashtagBudget !== undefined ? { hashtagBudget: deps.hashtagBudget } : {}),
    },
    withFakeOptIn,
    context,
  );
}
