/**
 * Discovery pipeline contracts (Phase 15).
 *
 * Discovery = provider-agnostic ingestion through an authorized source
 * connector: Raw Entity → Raw Snapshot persistence → Normalization →
 * Deduplication / Entity Resolution → Lead creation/update → ANALYSIS_PENDING.
 * Phase 18 adds Content ingestion from the same authorized payloads.
 *
 * Honesty rules (ADR-027):
 *  - A connector is resolved ONLY when the source row exists and a registered
 *    factory can build it for that source type.
 *  - A factory that requires credentials and does not find them returns
 *    ConnectorResolutionStatus NOT_CONFIGURED — the pipeline records the job
 *    as SKIPPED with an honest reason instead of pretending to discover.
 *  - Deterministic fake providers are for local E2E tests ONLY and are never
 *    selected for production source types by default.
 */

import type {
  DiscoveryRequest,
  LeadSourceConnector,
  SourceMetadata,
} from '@ulip/connectors';
import type { ContentIngestor } from './content.ts';

export type ConnectorResolutionStatus =
  | 'RESOLVED'
  | 'UNKNOWN_SOURCE_TYPE' // no factory registered for this source type
  | 'NOT_CONFIGURED' // factory exists but required credentials/config missing
  | 'UNSUPPORTED'; // factory exists but connector explicitly cannot serve this source

export interface ConnectorResolution {
  status: ConnectorResolutionStatus;
  connector?: LeadSourceConnector | undefined;
  /** Stable machine-readable reason when status is not RESOLVED. */
  reason?: string | undefined;
  /** True when this connector is a deterministic test/dev provider. */
  isDeterministicFake?: boolean | undefined;
}

/**
 * Builds connectors for one source type from tenant-scoped source config.
 * NEVER reaches the network inside resolve(); return NOT_CONFIGURED instead
 * of constructing a connector that cannot legally run.
 */
export interface ConnectorFactory {
  readonly sourceType: string;
  /** Validates config/credentials without any network call. */
  canBuild(config: Record<string, unknown>): { ok: boolean; reason?: string };
  build(config: Record<string, unknown>): LeadSourceConnector;
}

export interface SourceRecord {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
}

export interface SourceLookup {
  findById(tenantId: string, sourceId: string): Promise<SourceRecord | null>;
}

/** Persisted raw snapshot reference (raw_entities + raw_entity_currents). */
export interface RawSnapshot {
  id: string;
  isNewRevision: boolean;
}

export interface RawEntityStore {
  /**
   * Persists the raw payload immutably; dedupes on (source, externalId, hash)
   * via the DB unique constraint. Updates the "current" pointer.
   */
  persist(
    source: SourceRecord,
    entity: { sourceType: string; externalId: string; entityType: string; payload: Record<string, unknown>; collectedAt: string },
  ): Promise<RawSnapshot>;
  countForSource(tenantId: string, sourceId: string): Promise<number>;
}

export interface NormalizedFields {
  /** Persian-aware normalized display name (deterministic). */
  nameKey: string;
  displayName: string;
  username?: string | undefined;
  profileUrl?: string | undefined;
  /** Taxonomy hints extracted deterministically from raw fields (no AI here). */
  hints: Record<string, string>;
}

export interface Normalizer {
  normalize(entity: {
    sourceType: string;
    externalId: string;
    entityType: string;
    payload: Record<string, unknown>;
  }): NormalizedFields;
}

export interface ResolveOutcome {
  leadId: string;
  businessId: string;
  /** CREATED when a new business+lead row was born; UPDATED when reusing existing identity. */
  action: 'CREATED' | 'UPDATED';
}

/** Identity-key dedup + ER: (source_id, external_id) is the exact key; the
 *  normalizer's nameKey gives a deterministic same-name signal for review. */
export interface EntityResolver {
  resolve(
    tenantId: string,
    source: SourceRecord,
    normalized: NormalizedFields,
  ): Promise<ResolveOutcome>;
}

export interface DiscoveryFlowResult {
  requested: number;
  discovered: number;
  /** Skipped because the exact (source, externalId, hash) snapshot already existed. */
  unchanged: number;
  created: number;
  updated: number;
  /** raw_entities rows persisted during this run. */
  rawPersisted: number;
  /** Phase 18: NEW lead_contents rows persisted from payload posts/media. */
  contentsIngested: number;
}

export interface DiscoveryFlowDeps {
  log: { info(msg: string, fields?: Record<string, unknown>): void; error(msg: string, fields?: Record<string, unknown>): void };
  sources: SourceLookup;
  rawEntities: RawEntityStore;
  normalizer: Normalizer;
  resolver: EntityResolver;
  connectorRegistry: ConnectorRegistry;
  /** Phase 18 content ingestion (absent on legacy callers → skipped). */
  contentIngestor?: ContentIngestor | undefined;
}

export interface DiscoveryJobPayload {
  sourceId: string;
  query?: string | undefined;
  filters?: Record<string, string> | undefined;
  maxCandidates?: number | undefined;
  cursor?: string | undefined;
  /**
   * Explicit opt-in for the deterministic fake provider (Phase 20 preflight
   * fix): local E2E ONLY. The flow refuses fake connectors unless the job
   * payload itself carries `allowFake: true` — never selected by default.
   */
  allowFake?: boolean | undefined;
}

export class DiscoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryInputError';
  }
}

export class ConnectorNotAvailableError extends Error {
  readonly resolutionStatus: ConnectorResolutionStatus;
  constructor(status: ConnectorResolutionStatus, reason: string) {
    super(`connector unavailable (${status}): ${reason}`);
    this.name = 'ConnectorNotAvailableError';
    this.resolutionStatus = status;
  }
}

/**
 * Registry of ConnectorFactory instances. Unknown source type ⇒ honest
 * UNKNOWN_SOURCE_TYPE; a factory that refuses config ⇒ NOT_CONFIGURED.
 */
export class ConnectorRegistry {
  private readonly factories = new Map<string, ConnectorFactory>();

  register(factory: ConnectorFactory): void {
    this.factories.set(factory.sourceType, factory);
  }

  resolveFor(source: SourceRecord, opts: { allowDeterministicFakes?: boolean | undefined } = {}): ConnectorResolution {
    const factory = this.factories.get(source.type);
    if (factory === undefined) {
      return {
        status: 'UNKNOWN_SOURCE_TYPE',
        reason: `no connector factory registered for source type "${source.type}"`,
      };
    }
    const verdict = factory.canBuild(source.config);
    if (!verdict.ok) {
      return { status: 'NOT_CONFIGURED', reason: verdict.reason ?? 'source config missing required credentials' };
    }
    const connector = factory.build(source.config);
    const meta: SourceMetadata = connector.metadata();
    const isFake = typeof (connector as unknown as { isDeterministicFake?: boolean }).isDeterministicFake === 'boolean'
      ? (connector as unknown as { isDeterministicFake: boolean }).isDeterministicFake
      : false;
    if (isFake && opts.allowDeterministicFakes !== true) {
      return {
        status: 'UNSUPPORTED',
        reason: 'deterministic fake connector refused outside explicit allowDeterministicFakes mode',
      };
    }
  return {
    status: 'RESOLVED',
    connector,
    isDeterministicFake: isFake,
  };
}

  /** Source-type strings a caller may legitimately configure. */
  registeredTypes(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export function parseDiscoveryPayload(raw: unknown): DiscoveryJobPayload {
  if (typeof raw !== 'object' || raw === null) throw new DiscoveryInputError('payload must be an object');
  const p = raw as Record<string, unknown>;
  if (typeof p['sourceId'] !== 'string' || p['sourceId'] === '') {
    throw new DiscoveryInputError('payload.sourceId is required');
  }
  if (p['query'] !== undefined && typeof p['query'] !== 'string') {
    throw new DiscoveryInputError('payload.query must be a string');
  }
  if (p['filters'] !== undefined && (typeof p['filters'] !== 'object' || p['filters'] === null)) {
    throw new DiscoveryInputError('payload.filters must be an object');
  }
  const filters: Record<string, string> = {};
  if (p['filters'] !== undefined && p['filters'] !== null) {
    for (const [k, v] of Object.entries(p['filters'] as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new DiscoveryInputError(`payload.filters.${k} must be a string`);
      filters[k] = v;
    }
  }
  const maxRaw = p['maxCandidates'];
  if (maxRaw !== undefined && (typeof maxRaw !== 'number' || !Number.isInteger(maxRaw) || maxRaw < 1 || maxRaw > 10000)) {
    throw new DiscoveryInputError('payload.maxCandidates must be an integer in [1, 10000]');
  }
  if (p['cursor'] !== undefined && typeof p['cursor'] !== 'string') {
    throw new DiscoveryInputError('payload.cursor must be a string');
  }
  if (p['allowFake'] !== undefined && typeof p['allowFake'] !== 'boolean') {
    throw new DiscoveryInputError('payload.allowFake must be a boolean');
  }
  return {
    sourceId: p['sourceId'],
    query: p['query'] as string | undefined,
    filters,
    maxCandidates: maxRaw as number | undefined,
    cursor: p['cursor'] as string | undefined,
    ...(p['allowFake'] !== undefined ? { allowFake: p['allowFake'] as boolean } : {}),
  };
}

export function toConnectorRequest(payload: DiscoveryJobPayload): DiscoveryRequest {
  const req: DiscoveryRequest = {
    filters: payload.filters ?? {},
    limit: Math.min(payload.maxCandidates ?? 50, 10000),
  };
  if (payload.query !== undefined) req.query = payload.query;
  if (payload.cursor !== undefined) req.cursor = payload.cursor;
  return req;
}
