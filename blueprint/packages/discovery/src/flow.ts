/**
 * Discovery flow (Phase 15, ADR-027): the real production pipeline.
 *
 * Discovery Request → Source Connector → RawEntity → raw snapshot persistence
 * → Normalization (Persian-aware, deterministic) → Dedup / Entity Resolution
 * (identity keys + existing resolution tables) → Lead creation/update →
 * ANALYSIS_PENDING.
 *
 * Purity rules:
 *  - Raw payloads are stored verbatim, including on repeats (dedup on the
 *    (source, externalId, content hash) triple keeps snapshots immutable).
 *  - Deterministic transitions only: every lead moves through the canonical
 *    LEAD_TRANSITION_TABLE events, applied through the shared helper.
 *  - No network, no logging side effects: everything is expressed against the
 *    injected deps so tests run fully in-memory.
 */

import type {
  ConnectorRegistry,
  ConnectorResolution,
  ConnectorResolutionStatus,
  DiscoveryFlowDeps,
  DiscoveryFlowResult,
  DiscoveryJobPayload,
  Normalizer,
  RawEntityStore,
  SourceLookup,
  SourceRecord,
} from './contracts.ts';

import { ConnectorNotAvailableError, DiscoveryInputError, parseDiscoveryPayload, toConnectorRequest } from './contracts.ts';

export type {
  ConnectorNotAvailableError,
  ConnectorRegistry,
  ConnectorResolution,
  ConnectorResolutionStatus,
  DiscoveryFlowDeps,
  DiscoveryFlowResult,
  DiscoveryInputError,
  DiscoveryJobPayload,
  Normalizer,
  RawEntityStore,
  SourceLookup,
  SourceRecord,
};

const DEFAULT_MAX_CANDIDATES = 50;
const HARD_MAX_CANDIDATES = 10_000;

/**
 * Runs one discovery job end-to-end. Throws DiscoveryInputError for malformed
 * payloads and ConnectorNotAvailableError for unresolvable connectors — the
 * caller (worker) decides the persistent job outcome per failure policy.
 */
export async function runDiscovery(
  deps: DiscoveryFlowDeps,
  rawPayload: unknown,
  context: { tenantId: string; jobId?: string | undefined; requestId?: string | undefined } ,
): Promise<DiscoveryFlowResult> {
  const payload = parseDiscoveryPayload(rawPayload);

  const source = await deps.sources.findById(context.tenantId, payload.sourceId);
  if (source === null) {
    throw new DiscoveryInputError(`source ${payload.sourceId} not found in tenant ${context.tenantId}`);
  }

  const resolution = deps.connectorRegistry.resolveFor(source, { allowDeterministicFakes: true });
  if (resolution.status !== 'RESOLVED' || resolution.connector === undefined) {
    throw new ConnectorNotAvailableError(resolution.status, resolution.reason ?? 'unresolved connector');
  }
  const connector = resolution.connector;

  if (!connector.supports('profile_search')) {
    throw new ConnectorNotAvailableError(
      'UNSUPPORTED',
      `connector "${connector.metadata().type}" does not advertise profile_search`,
    );
  }

  const limit = Math.min(payload.maxCandidates ?? DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES);
  const request = { ...toConnectorRequest(payload), limit };

  deps.log.info('discovery: connector search starting', {
    jobId: context.jobId,
    requestId: context.requestId,
    tenantId: context.tenantId,
    sourceId: source.id,
    sourceType: source.type,
    limit,
  });

  const result = await connector.search(request);

  deps.log.info('discovery: connector search finished', {
    jobId: context.jobId,
    requestId: context.requestId,
    tenantId: context.tenantId,
    sourceId: source.id,
    items: result.items.length,
    partial: result.partial,
    warnings: result.warnings.length,
  });

  const outcome: DiscoveryFlowResult = {
    requested: limit,
    discovered: 0,
    unchanged: 0,
    created: 0,
    updated: 0,
    rawPersisted: 0,
  };

  for (const item of result.items) {
    outcome.discovered += 1;

    // 1) Raw snapshot — immutable, verbatim, provenance + collectedAt kept.
    const snapshot = await deps.rawEntities.persist(source, {
      sourceType: item.sourceType,
      externalId: item.externalId,
      entityType: item.entityType,
      payload: item.payload,
      collectedAt: item.collectedAt,
    });
    if (snapshot.isNewRevision) outcome.rawPersisted += 1;
    else {
      outcome.unchanged += 1;
      // Identical payload re-ingested: still resolve the lead so repeats stay
      // idempotent, but skip normalization/dedup work (same inputs, same keys).
    }

    // 2) Normalization — deterministic, Persian-aware, no AI.
    const normalized = deps.normalizer.normalize({
      sourceType: item.sourceType,
      externalId: item.externalId,
      entityType: item.entityType,
      payload: item.payload,
    });

    // 3) Dedup + ER + lead creation/update (identity key: source+externalId).
    const resolved = await deps.resolver.resolve(context.tenantId, source, normalized);
    if (resolved.action === 'CREATED') outcome.created += 1;
    else outcome.updated += 1;

    deps.log.info('discovery: item processed', {
      jobId: context.jobId,
      requestId: context.requestId,
      tenantId: context.tenantId,
      sourceId: source.id,
      externalId: item.externalId,
      rawEntityId: snapshot.id,
      leadId: resolved.leadId,
      businessId: resolved.businessId,
      action: resolved.action,
    });
  }

  deps.log.info('discovery: flow complete', {
    jobId: context.jobId,
    requestId: context.requestId,
    tenantId: context.tenantId,
    sourceId: source.id,
    ...outcome,
    partial: result.partial,
    nextCursor: result.nextCursor,
  });

  return outcome;
}
