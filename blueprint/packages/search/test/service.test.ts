/**
 * @ulip/search service-level unit tests — LLM path, fallback path, planner.
 * Pure in-memory; no DB required. (Parser/ranker tests live in search.test.ts.)
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SearchService } from '../src/service.ts';
import { CapabilityDiscoveryPlanner } from '../src/planner.ts';
import type { SearchRow, ResolvedTaxonomy, SearchServiceDeps, PlannerDeps, DiscoveryPlanStep, TaxonomyResolver } from '../src/contracts.ts';
import type { LeadSearchFilters } from '@ulip/domain/contracts';
import { ConnectorRegistry, DeterministicFakeConnectorFactory, ConfiguredHttpApiConnectorFactory } from '@ulip/discovery';

function taxonomyOf(_tenantId: string, _filters: LeadSearchFilters): ResolvedTaxonomy {
  return { businessTypes: [], industries: [], specialties: [], subSpecialties: [], terms: [], unresolved: [], city: null };
}

function taxonomyResolver(): TaxonomyResolver {
  return { async resolve(t, f) { return taxonomyOf(t, f); } };
}

function sampleRow(partial: Partial<SearchRow>): SearchRow {
  return {
    id: 'l1',
    businessId: 'b1',
    status: 'SCORED',
    canonicalName: 'Test Business',
    description: null,
    website: null,
    identities: [],
    city: 'Tehran',
    country: 'Iran',
    scores: null,
    matched: { businessType: false, industry: false, specialty: false, subSpecialty: false, brand: false, city: false, country: false, content: false, name: false },
    contentMatches: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function depsWith(overrides: Partial<SearchServiceDeps>): SearchServiceDeps {
  return {
    llm: null,
    taxonomy: taxonomyResolver(),
    executor: { async search() { return { rows: [], total: 0 }; } },
    planner: { async plan(i) { void i; return { mode: 'EXISTING_ONLY' as const, steps: [], executed: false, note: 'x' }; } },
    ...overrides,
  };
}

test('service: untrusted LLM output is sanitized (invalid status dropped, thresholds clamped, node ids carried)', async () => {
  const seen: { filters: LeadSearchFilters }[] = [];
  const svc = new SearchService(
    depsWith({
      llm: {
        async parseSearchQuery() {
          return {
            filters: {
              brands: ['HP'],
              city: 'Tehran',
              status: 'NOT_A_STATUS' as unknown as undefined,
              minRelevance: 500,
              subSpecialties: 42 as unknown as string[],
            } as unknown as LeadSearchFilters,
            confidence: 0.9,
            unmatchedTerms: ['قطعات'],
            meta: { provider: 'fake-llm', modelVersion: 'fake-1' },
          };
        },
      },
      taxonomy: {
        async resolve(_t, filters) {
          seen.push({ filters });
          assert.equal(filters.status, undefined, 'invalid LLM status must be dropped by sanitize');
          assert.equal(filters.subSpecialties, undefined, 'non-string list values must be dropped');
          assert.equal(filters.minRelevance, 100, 'LLM thresholds clamped to 0..100');
          return {
            businessTypes: [],
            industries: [],
            specialties: ['11111111-1111-1111-1111-111111111111'],
            subSpecialties: [],
            terms: [{ field: 'specialties' as const, term: 'قطعات پرینتر', nodeId: '11111111-1111-1111-1111-111111111111', via: 'ALIAS' as const }],
            unresolved: ['قطعات'],
            city: { raw: 'Tehran', canonical: 'تهران', country: 'Iran' },
          };
        },
      },
      executor: {
        async search(_tenantId, filters, pagination, sort) {
          assert.equal(_tenantId, 't1');
          assert.deepEqual(filters.specialtyNodeIds, ['11111111-1111-1111-1111-111111111111']);
          assert.equal(filters.status, null);
          assert.equal(filters.minRelevance, 100);
          assert.equal(filters.city, 'تهران', 'city resolved canonically through location alias');
          assert.deepEqual(pagination, { page: 1, limit: 50 });
          assert.deepEqual(sort, []);
          return {
            rows: [
              sampleRow({
                id: 'lead-1',
                matched: { ...sampleRow({}).matched, specialty: true },
                scores: { relevance: 40, audienceQuality: 40, activity: 40, confidence: 40, priority: 40 },
                contentMatches: ['قطعات پرینتر HP'],
              }),
            ],
            total: 1,
          };
        },
      },
    }),
  );

  const { response } = await svc.executeNaturalLanguage('t1', { text: 'قطعات پرینتر', locale: 'fa' });
  assert.equal(response.parser.kind, 'LLM');
  assert.equal(response.data.length, 1);
  assert.equal(response.data[0]?.searchScore, 50, 'no scores ⇒ neutral 50 baseline + 10 SPECIALTY_MATCH boost');
  assert.ok(response.resolution.terms.length === 1 && response.resolution.terms[0]?.via === 'ALIAS');
  // Phase 20.1: a RESOLVED taxonomy term stays in the content path —
  // resolved label 'قطعات پرینتر' + unresolved 'قطعات', bounded + deduped.
  assert.deepEqual(response.resolution.contentTerms, ['قطعات پرینتر', 'قطعات']);
  assert.equal(seen.length, 1);
});

test('service: AI NOT_CONFIGURED ⇒ deterministic fallback parser used, honest parser kind', async () => {
  let resolveCalls = 0;
  const svc = new SearchService(depsWith({
    taxonomy: {
      async resolve(t, f) {
        resolveCalls += 1;
        return taxonomyOf(t, f);
      },
    },
  }));
  const { response } = await svc.executeNaturalLanguage('t9', { text: 'عمده فروش قطعات پرینتر در تهران' });
  assert.equal(response.parser.kind, 'RULES_FALLBACK');
  assert.equal(response.locale, 'fa');
  assert.equal(resolveCalls, 1);
  assert.ok(response.execution.discoveryPlan.note.length > 0);
  assert.ok((response.structuredQuery.filters.businessTypes ?? []).includes('Wholesaler'));
  assert.equal(response.structuredQuery.filters.city, 'Tehran');
});

test('service: failing LLM falls back to rules parser (AI unavailable is honest, not fatal)', async () => {
  let warned: string | null = null;
  const svc = new SearchService(depsWith({
    llm: { async parseSearchQuery() { throw new Error('provider down'); } },
    log: { info() { /* noop */ }, warn(msg: string) { warned = msg; } },
  }));
  const { response } = await svc.executeNaturalLanguage('t1', { text: 'hello world' });
  assert.equal(response.parser.kind, 'RULES_FALLBACK');
  assert.ok(warned !== null, 'fallback must be logged as a warning');
  assert.ok(response.unmatchedTerms.length > 0, 'unmatched words surface honestly');
});

test('service: empty text rejected, oversized text rejected', async () => {
  const svc = new SearchService(depsWith({}));
  await assert.rejects(() => svc.executeNaturalLanguage('t1', { text: '   ' }), /text is required/);
  await assert.rejects(() => svc.executeNaturalLanguage('t1', { text: 'x'.repeat(1001), }), /too long/);
});

test('service: DISCOVER_WHEN_SUPPORTED without allowFake never executes a fake source', async () => {
  const svc = new SearchService(depsWith({
    planner: {
      async plan(i) {
        void i;
        return {
          mode: 'DISCOVER_WHEN_SUPPORTED' as const,
          steps: [{ sourceId: 's1', sourceType: 'FAKE', sourceName: 'fake', sourceStatus: 'ACTIVE', connectorResolution: 'RESOLVED' as const, isDeterministicFake: true, verdict: 'PARTIAL' as const, reason: 'allowFake required' }],
          executed: false,
          note: 'no source supports this query for discovery; nothing was attempted (honest refusal)',
        };
      },
    },
  }));
  const { response } = await svc.executeNaturalLanguage('t1', { text: 'hello', mode: 'DISCOVER_WHEN_SUPPORTED' });
  assert.equal(response.execution.discoveryPlan.executed, false);
  assert.equal((response.execution.discoveryPlan.steps[0] as DiscoveryPlanStep).verdict, 'PARTIAL');
});

// ------------------------------------------------------------- planner tests

function source(tenantId: string, id: string, type: string, config: Record<string, unknown> = {}): { id: string; tenantId: string; type: string; name: string; status: string; config: Record<string, unknown> } {
  return { id, tenantId, type, name: `src-${id}`, status: 'ACTIVE', config };
}

function plannerDeps(sources: { id: string; tenantId: string; type: string; name: string; status: string; config: Record<string, unknown> }[], enqueued: string[] = []): { deps: PlannerDeps; enqueued: string[]; enqueueInputs: { tenantId: string; sourceId: string; allowFake?: boolean | undefined; query?: string | undefined }[] } {
  const enqueueInputs: { tenantId: string; sourceId: string; allowFake?: boolean | undefined; query?: string | undefined }[] = [];
  return {
    deps: {
      async listSources(tenantId) {
        return sources.filter((s) => s.tenantId === tenantId);
      },
      async enqueueDiscovery(input: { tenantId: string; sourceId: string; allowFake?: boolean | undefined; query?: string | undefined }) {
        void input.tenantId;
        enqueued.push(input.sourceId + (input.query !== undefined ? `:${input.query}` : ''));
        enqueueInputs.push({ tenantId: input.tenantId, sourceId: input.sourceId, allowFake: input.allowFake, query: input.query });
        return { jobId: 'job-1' };
      },
    },
    enqueued,
    enqueueInputs,
  };
}

function registryAll(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  registry.register(new DeterministicFakeConnectorFactory());
  return registry;
}

test('planner: INSTAGRAM without #hashtag/@user is honestly UNSUPPORTED for broad semantic search', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const { deps, enqueued } = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const plan = await planner.plan({ tenantId: 't1', text: 'عمده فروشان قطعات پرینتر در تهران', structuredQuery: { filters: { brands: ['HP'] }, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'EXISTING_ONLY', allowFake: false });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.verdict, 'PARTIAL');
  assert.match(plan.steps[0]?.reason ?? '', /no broad semantic/);
  assert.equal(plan.executed, false);
  assert.equal(enqueued.length, 0);
});

test('planner: INSTAGRAM with explicit #hashtag is SUPPORTED; DISCOVER_WHEN_SUPPORTED enqueues it', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const { deps, enqueued } = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const plan = await planner.plan({ tenantId: 't1', text: 'find #printerparts sellers', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: false });
  assert.equal(plan.steps[0]?.verdict, 'SUPPORTED');
  assert.equal(plan.steps[0]?.proposedQuery, 'printerparts');
  assert.equal(plan.executed, true);
  assert.deepEqual(enqueued, ['s1:printerparts']);
});

test('planner: INSTAGRAM with @username is SUPPORTED (Business Discovery)', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const { deps } = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const plan = await planner.plan({ tenantId: 't1', text: 'look at @printer_parts_shop', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'EXISTING_ONLY', allowFake: false });
  assert.equal(plan.steps[0]?.verdict, 'SUPPORTED');
  assert.equal(plan.steps[0]?.proposedQuery, 'printer_parts_shop');
});

test('planner: fake source refused without allowFake even in DISCOVER_WHEN_SUPPORTED', async () => {
  const { deps, enqueued } = plannerDeps([source('t1', 's1', 'FAKE')]);
  const planner = new CapabilityDiscoveryPlanner(deps, registryAll());
  const plan = await planner.plan({ tenantId: 't1', text: 'anything', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: false });
  assert.equal(plan.steps[0]?.verdict, 'PARTIAL');
  assert.equal(plan.executed, false);
  assert.equal(enqueued.length, 0);
  const plan2 = await planner.plan({ tenantId: 't1', text: 'anything', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: true });
  assert.equal(plan2.steps[0]?.verdict, 'SUPPORTED');
  assert.equal(plan2.executed, true);
  assert.equal(plan2.jobId, 'job-1');
  // Phase 20.1: the planner's allowFake verdict and the enqueue payload MUST
  // agree — true only when a fake step was actually chosen for execution.
  const { deps: deps3, enqueueInputs } = plannerDeps([source('t1', 's1', 'FAKE')]);
  const planner3 = new CapabilityDiscoveryPlanner(deps3, registryAll());
  await planner3.plan({ tenantId: 't1', text: 'anything', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: true });
  assert.equal(enqueueInputs.length, 1);
  assert.equal(enqueueInputs[0]?.sourceId, 's1');
  assert.equal(enqueueInputs[0]?.allowFake, true, 'fake source chosen for execution must carry allowFake: true in the enqueue payload');
  // Real (non-fake) source: allowFake must NOT ride into the payload.
  const { deps: deps4, enqueueInputs: enqueueInputs4 } = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const registry4 = new ConnectorRegistry();
  registry4.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const planner4 = new CapabilityDiscoveryPlanner(deps4, registry4);
  await planner4.plan({ tenantId: 't1', text: '#printerparts', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: true });
  assert.equal(enqueueInputs4.length, 1);
  assert.equal(enqueueInputs4[0]?.allowFake, undefined, 'real-source enqueue must not carry allowFake');
});

test('planner: HTTP_API boundary honestly UNSUPPORTED (no capabilities advertised)', async () => {
  const { deps } = plannerDeps([source('t1', 's1', 'HTTP_API', { provider: 'p', apiBaseUrl: 'https://api.example.test', apiToken: 't' })]);
  const planner = new CapabilityDiscoveryPlanner(deps, registryAll());
  const plan = await planner.plan({ tenantId: 't1', text: 'hello', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: false });
  assert.equal(plan.steps[0]?.verdict, 'UNSUPPORTED');
  assert.match(plan.steps[0]?.reason ?? '', /profile_search/);
  assert.equal(plan.executed, false);
});

test('planner: tenant isolation — sources of another tenant are invisible', async () => {
  const { deps } = plannerDeps([source('other-tenant', 's1', 'FAKE')]);
  const planner = new CapabilityDiscoveryPlanner(deps, registryAll());
  const plan = await planner.plan({ tenantId: 't1', text: 'hello', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: true });
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.executed, false);
});

test('planner: inactive source is UNSUPPORTED with honest reason', async () => {
  const { deps } = plannerDeps([{ id: 's1', tenantId: 't1', type: 'FAKE', name: 'src-s1', status: 'PAUSED', config: {} }]);
  const planner = new CapabilityDiscoveryPlanner(deps, registryAll());
  const plan = await planner.plan({ tenantId: 't1', text: 'hello', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'EXISTING_ONLY', allowFake: true });
  assert.equal(plan.steps[0]?.verdict, 'UNSUPPORTED');
  assert.match(plan.steps[0]?.reason ?? '', /PAUSED/);
});

test('planner: NOT_CONFIGURED instagram (missing token) is UNSUPPORTED with honest reason', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const { deps } = plannerDeps([source('t1', 's1', 'INSTAGRAM', {})]);
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const plan = await planner.plan({ tenantId: 't1', text: '#tag', structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } }, resolved: taxonomyOf('t1', {}), mode: 'DISCOVER_WHEN_SUPPORTED', allowFake: false });
  assert.equal(plan.steps[0]?.connectorResolution, 'NOT_CONFIGURED');
  assert.equal(plan.steps[0]?.verdict, 'UNSUPPORTED');
});

// ------------------------------------------------- Phase 21 planner enrichment

test('planner: PARTIAL instagram step carries deterministic hashtag candidates + classified constraints', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const { deps } = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const resolved = taxonomyOf('t1', {});
  resolved.terms.push({ field: 'specialties', term: 'printer parts', nodeId: '11111111-1111-1111-1111-111111111111', via: 'ALIAS' });
  resolved.unresolved.push('بیش از ۵۰۰۰ فالوئر', 'فعال در تهران', 'تهران');
  const plan = await planner.plan({
    tenantId: 't1',
    text: 'عمده فروشان قطعات پرینتر در تهران',
    structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } },
    resolved,
    mode: 'EXISTING_ONLY',
    allowFake: false,
  });
  const step = plan.steps[0]!;
  assert.equal(step.verdict, 'PARTIAL');
  // Deterministic candidates: no alias table wired → term text surface.
  assert.ok(step.hashtagCandidates !== undefined, 'PARTIAL step must carry hashtagCandidates when taxonomy resolved a term');
  assert.ok((step.hashtagCandidates?.length ?? 0) >= 1);
  for (const c of step.hashtagCandidates ?? []) {
    assert.ok(c.hashtag.length >= 2);
    assert.ok(c.via.startsWith('term:slug') || c.via.startsWith('term:name') || c.via.startsWith('term:alias') || c.via.startsWith('term:'), `via must carry provenance, got ${c.via}`);
  }
  // Constraints classified honestly (Persian digits normalized: ۵۰۰۰ → 5000).
  const follower = step.classifiedConstraints?.find((c) => c.kind === 'POST_FETCH_FILTER');
  assert.ok(follower !== undefined, 'follower threshold must classify as POST_FETCH_FILTER');
  assert.match(follower?.note ?? '', />= 5000/);
  const activity = step.classifiedConstraints?.find((c) => c.kind === 'POST_FETCH_HEURISTIC');
  assert.ok(activity !== undefined, 'activity constraint must classify as POST_FETCH_HEURISTIC');
  const city = step.classifiedConstraints?.find((c) => c.kind === 'AI_ANALYSIS');
  assert.ok(city !== undefined, 'city constraint must classify as AI_ANALYSIS (evidence-based)');
});

test('planner: taxonomyAliases dependency supplies real alias surfaces (rank dedupes, provenance alias:<norm>)', async () => {
  const registry = new ConnectorRegistry();
  registry.register(new (await import('@ulip/discovery')).InstagramGraphConnectorFactory());
  const base = plannerDeps([source('t1', 's1', 'INSTAGRAM', { provider: 'instagram-graph', accessToken: 'token-token-token', igUserId: '123456789' })]);
  const deps: PlannerDeps = {
    ...base.deps,
    async taxonomyAliases(nodeIds) {
      assert.deepEqual(nodeIds, ['11111111-1111-1111-1111-111111111111']);
      return [{ nodeId: nodeIds[0]!, name: 'قطعات پرینتر', slug: 'printer-parts', aliases: ['لوازم پرینتر', 'printer parts'] }];
    },
  };
  const planner = new CapabilityDiscoveryPlanner(deps, registry);
  const resolved = taxonomyOf('t1', {});
  resolved.terms.push({ field: 'specialties', term: 'قطعات پرینتر', nodeId: '11111111-1111-1111-1111-111111111111', via: 'NAME' });
  const plan = await planner.plan({
    tenantId: 't1',
    text: 'قطعات پرینتر',
    structuredQuery: { filters: {}, pagination: { page: 1, limit: 50 } },
    resolved,
    mode: 'EXISTING_ONLY',
    allowFake: false,
  });
  const step = plan.steps[0]!;
  assert.equal(step.verdict, 'PARTIAL');
  const cands = step.hashtagCandidates ?? [];
  assert.ok(cands.some((c) => c.hashtag === 'printer_parts' || c.hashtag === 'printerparts'), `slug-derived hashtag expected, got ${JSON.stringify(cands)}`);
  assert.ok(cands.some((c) => c.via.startsWith('alias:')));
});
