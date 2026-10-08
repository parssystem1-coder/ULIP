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
    },
    withFakeOptIn,
    context,
  );
}
