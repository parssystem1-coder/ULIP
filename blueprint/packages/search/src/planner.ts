/**
 * Capability-aware discovery planner (Phase 20).
 *
 * Inspects the tenant's ACTIVE sources through the real ConnectorRegistry and
 * reports, per source, whether the natural-language query can be discovered:
 *
 *  - FAKE (explicit opt-in only): SUPPORTED — any text query.
 *  - INSTAGRAM (authorized Graph API): the API exposes ONLY hashtag and
 *    username discovery — broad semantic/location queries are honestly
 *    UNSUPPORTED. `#tag` or `@user` in the text makes it SUPPORTED; a parsed
 *    brand alone yields PARTIAL (a hashtag to confirm, never auto-run).
 *  - HTTP_API: the configured boundary advertises no capabilities yet →
 *    UNSUPPORTED until a real adapter exists.
 *
 * Execution (mode=DISCOVER_WHEN_SUPPORTED) enqueues a discovery job ONLY for
 * verdict=SUPPORTED steps; PARTIAL/UNSUPPORTED are reported, never attempted.
 * In production, fake sources are only executed with the explicit allowFake
 * opt-in (mirrors the discovery API contract).
 */

import type { ConnectorRegistry } from '@ulip/discovery';
import type { StructuredSearchQuery } from '@ulip/domain/contracts';
import type {
  DiscoveryPlan,
  DiscoveryPlanStep,
  DiscoveryPlanner,
  ExecutionMode,
  PlannerDeps,
  ResolvedTaxonomy,
} from './contracts.ts';

const HASHTAG_RE = /#([\p{L}\p{N}_]{2,50})/u;
const USERNAME_RE = /@([A-Za-z0-9._]{2,50})/;

/** Slugifies a brand into a plausible hashtag (confirmation required — PARTIAL). */
function slugHashtag(brand: string): string {
  return brand.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class CapabilityDiscoveryPlanner implements DiscoveryPlanner {
  private readonly deps: PlannerDeps;
  private readonly registry: ConnectorRegistry;

  constructor(deps: PlannerDeps, registry: ConnectorRegistry) {
    this.deps = deps;
    this.registry = registry;
  }

  async plan(input: {
    tenantId: string;
    text: string;
    structuredQuery: StructuredSearchQuery;
    resolved: ResolvedTaxonomy;
    mode: ExecutionMode;
    allowFake: boolean;
    correlationId?: string | undefined;
  }): Promise<DiscoveryPlan> {
    const sources = await this.deps.listSources(input.tenantId);
    const hashtag = HASHTAG_RE.exec(input.text)?.[1];
    const usernames = [...input.text.matchAll(/@([A-Za-z0-9._]{2,50})/g)].map((m) => m[1] ?? '');
    const uniqueUsernames = [...new Set(usernames.filter((u) => u !== ''))];

    const steps: DiscoveryPlanStep[] = [];
    for (const source of sources) {
      if (source.status !== 'ACTIVE') {
        steps.push({
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          sourceStatus: source.status,
          connectorResolution: 'RESOLVED',
          isDeterministicFake: false,
          verdict: 'UNSUPPORTED',
          reason: `source status is ${source.status}; discovery requires ACTIVE`,
        });
        continue;
      }

      const resolution = this.registry.resolveFor(source, { allowDeterministicFakes: true });
      if (resolution.status !== 'RESOLVED' || resolution.connector === undefined) {
        steps.push({
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          sourceStatus: source.status,
          connectorResolution: resolution.status,
          isDeterministicFake: resolution.isDeterministicFake === true,
          verdict: 'UNSUPPORTED',
          reason: resolution.reason ?? 'connector not resolvable for this source',
        });
        continue;
      }

      const connector = resolution.connector;
      const isFake = resolution.isDeterministicFake === true;

      if (!connector.supports('profile_search')) {
        steps.push({
          sourceId: source.id,
          sourceType: source.type,
          sourceName: source.name,
          sourceStatus: source.status,
          connectorResolution: 'RESOLVED',
          isDeterministicFake: isFake,
          verdict: 'UNSUPPORTED',
          reason: `connector "${source.type}" does not advertise profile_search — no discovery surface`,
        });
        continue;
      }

      if (source.type === 'INSTAGRAM') {
        // Honest capability mapping for the authorized Graph API:
        // hashtag + username discovery exist; broad semantic/location search does not.
        if (hashtag !== undefined) {
          steps.push({
            sourceId: source.id,
            sourceType: source.type,
            sourceName: source.name,
            sourceStatus: source.status,
            connectorResolution: 'RESOLVED',
            isDeterministicFake: isFake,
            verdict: 'SUPPORTED',
            reason: 'INSTAGRAM hashtag discovery is supported; the query carries an explicit #hashtag',
            proposedQuery: hashtag,
          });
        } else if (uniqueUsernames.length > 0) {
          steps.push({
            sourceId: source.id,
            sourceType: source.type,
            sourceName: source.name,
            sourceStatus: source.status,
            connectorResolution: 'RESOLVED',
            isDeterministicFake: isFake,
            verdict: 'SUPPORTED',
            reason: 'INSTAGRAM username discovery (Business Discovery) is supported; the query carries @usernames',
            proposedQuery: uniqueUsernames.join(','),
          });
        } else {
          const brand = input.structuredQuery.filters.brands?.[0];
          const proposed = brand !== undefined ? slugHashtag(brand) : undefined;
          steps.push({
            sourceId: source.id,
            sourceType: source.type,
            sourceName: source.name,
            sourceStatus: source.status,
            connectorResolution: 'RESOLVED',
            isDeterministicFake: isFake,
            verdict: 'PARTIAL',
            reason:
              'the authorized Instagram Graph API exposes no broad semantic or location search; only hashtag/username discovery exists' +
              (proposed !== undefined && proposed !== ''
                ? ` — a hashtag like "#${proposed}" could be derived from the parsed brand (confirm before running)`
                : ' — derive an explicit #hashtag to enable discovery'),
            ...(proposed !== undefined && proposed !== '' ? { proposedQuery: proposed } : {}),
          });
        }
        continue;
      }

      if (isFake) {
        if (!input.allowFake) {
          steps.push({
            sourceId: source.id,
            sourceType: source.type,
            sourceName: source.name,
            sourceStatus: source.status,
            connectorResolution: 'RESOLVED',
            isDeterministicFake: true,
            verdict: 'PARTIAL',
            reason: 'deterministic fake source is capable but execution requires the explicit allowFake opt-in',
          });
        } else {
          steps.push({
            sourceId: source.id,
            sourceType: source.type,
            sourceName: source.name,
            sourceStatus: source.status,
            connectorResolution: 'RESOLVED',
            isDeterministicFake: true,
            verdict: 'SUPPORTED',
            reason: 'deterministic fake provider accepts any text query (explicit allowFake opt-in present)',
            proposedQuery: input.text.slice(0, 200),
          });
        }
        continue;
      }

      // Generic capable connector (e.g. a future real provider advertising
      // profile_search): the free-text query rides through as-is.
      steps.push({
        sourceId: source.id,
        sourceType: source.type,
        sourceName: source.name,
        sourceStatus: source.status,
        connectorResolution: 'RESOLVED',
        isDeterministicFake: false,
        verdict: 'SUPPORTED',
        reason: `connector "${source.type}" advertises profile_search; the query text rides through as the discovery query`,
        proposedQuery: input.text.slice(0, 200),
      });
    }

    const mode = input.mode;
    const supported = steps.filter((s) => s.verdict === 'SUPPORTED');

    if (mode === 'EXISTING_ONLY') {
      return {
        mode,
        steps,
        executed: false,
        note:
          supported.length > 0
            ? 'searched existing leads only; capable sources are listed with verdict SUPPORTED (use mode=DISCOVER_WHEN_SUPPORTED to also discover)'
            : 'searched existing leads only; no source can serve this query for discovery (verdicts are honest per connector capabilities)',
      };
    }

    // DISCOVER_WHEN_SUPPORTED: execute ONLY the first SUPPORTED step.
    const chosen = supported[0];
    if (chosen === undefined) {
      return {
        mode,
        steps,
        executed: false,
        note: 'no source supports this query for discovery; nothing was attempted (honest refusal)',
      };
    }
    const { jobId } = await this.deps.enqueueDiscovery({
      tenantId: input.tenantId,
      sourceId: chosen.sourceId,
      query: chosen.proposedQuery,
      filters: chosen.proposedFilters,
      correlationId: input.correlationId,
    });
    return {
      mode,
      steps,
      executed: true,
      jobId,
      note: `discovery job ${jobId} enqueued for source ${chosen.sourceName} (${chosen.sourceType})`,
    };
  }
}
