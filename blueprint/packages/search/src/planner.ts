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
import { classifyConstraints, hashtagsFromTaxonomy, type TaxonomyAliasInput } from '@ulip/discovery';
import type {
  DiscoveryPlan,
  DiscoveryPlanStep,
  DiscoveryPlanner,
  ExecutionMode,
  PlannerDeps,
  ResolvedTerm,
  ResolvedTaxonomy,
} from './contracts.ts';

const HASHTAG_RE = /#([\p{L}\p{N}_]{2,50})/u;
const USERNAME_RE = /@([A-Za-z0-9._]{2,50})/;

/** Slugifies a brand into a plausible hashtag (confirmation required — PARTIAL). */
function slugHashtag(brand: string): string {
  return brand.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MAX_CANDIDATES = 5; // deterministic top-N hashtag candidates per step

/**
 * Hashtag candidates derived DETERMINISTICALLY from resolved taxonomy surfaces
 * (Phase 21). Inputs come from PlannerDeps.taxonomyAliases when wired (real
 * alias_norm rows); falls back to resolved term text. Every candidate carries
 * provenance (via=slug|name|alias) and a stable rank — replayable, no
 * fabricated hashtags.
 */
function taxonomyHashtagCandidates(resolved: ResolvedTaxonomy, aliases: TaxonomyAliasInput[]): ReturnType<typeof hashtagsFromTaxonomy> {
  if (aliases.length > 0) {
    const seen = new Set<string>();
    const out: ReturnType<typeof hashtagsFromTaxonomy> = [];
    for (const node of aliases) {
      for (const cand of hashtagsFromTaxonomy(node, MAX_CANDIDATES)) {
        if (seen.has(cand.hashtag)) continue;
        seen.add(cand.hashtag);
        out.push({ ...cand, rank: out.length + 1 });
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
    return out;
  }
  // Fallback: resolved term text as a single candidate surface (honest note
  // via=term — no alias table available at planning time).
  const term = resolved.terms.find((t) => t.nodeId !== null)?.term ?? resolved.unresolved[0];
  if (term === undefined || term.trim() === '') return [];
  return hashtagsFromTaxonomy({ name: term, slug: term, aliases: [] }, MAX_CANDIDATES).map((c) => ({ ...c, via: `term:${c.via}` }));
}

export class CapabilityDiscoveryPlanner implements DiscoveryPlanner {
  private readonly deps: PlannerDeps;
  private readonly registry: ConnectorRegistry;

  constructor(deps: PlannerDeps, registry: ConnectorRegistry) {
    this.deps = deps;
    this.registry = registry;
  }

  /**
   * Phase 21 derivations for steps that would benefit a hashtag discovery:
   * deterministic candidates from taxonomy surfaces + honest classification
   * of every constraint the user expressed. Never throws — a planning
   * enrichment failure must not hide the honest verdict itself.
   */
  private async enrich(
    resolved: ResolvedTaxonomy,
    constraintTexts: string[],
  ): Promise<Pick<DiscoveryPlanStep, 'hashtagCandidates' | 'classifiedConstraints'>> {
    const nodeIds = [...new Set(resolved.terms.filter((t) => t.nodeId !== null).map((t) => t.nodeId as string))];
    let aliasInputs: TaxonomyAliasInput[] = [];
    if (nodeIds.length > 0 && typeof this.deps.taxonomyAliases === 'function') {
      try {
        aliasInputs = await this.deps.taxonomyAliases(nodeIds);
      } catch {
        aliasInputs = []; // honest fallback to term text below
      }
    }
    const candidates = taxonomyHashtagCandidates(resolved, aliasInputs);
    const classified = classifyConstraints(constraintTexts);
    return {
      ...(candidates.length > 0 ? { hashtagCandidates: candidates } : {}),
      ...(classified.length > 0 ? { classifiedConstraints: classified } : {}),
    };
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
          // Phase 21: enrich the honest PARTIAL verdict with deterministic
          // hashtag candidates from taxonomy surfaces + the constraint map.
          // Constraint texts = unresolved terms (the parts the parser could
          // not type) — these carry e.g. follower thresholds or city names.
          let enrichment: Pick<DiscoveryPlanStep, 'hashtagCandidates' | 'classifiedConstraints'> = {};
          if (hashtag === undefined) {
            enrichment = await this.enrich(input.resolved, [...input.resolved.unresolved]);
          }
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
            ...enrichment,
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
      // Phase 20.1: the persisted payload must agree with the planner verdict —
      // only a SUPPORTED fake step (which requires input.allowFake) reaches here.
      allowFake: chosen.isDeterministicFake ? input.allowFake : undefined,
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
