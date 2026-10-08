/**
 * @ulip/search unit tests (Phase 20) — parser, ranker, service orchestration.
 * Pure in-memory; no DB required.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DeterministicQueryParser } from '../src/parser.ts';
import { rankRows, rankRow } from '../src/ranker.ts';
import { SearchService, emptyStructuredQuery } from '../src/service.ts';
import type { SearchRow, ResolvedTaxonomy, TaxonomyResolver } from '../src/contracts.ts';
import type { LeadSearchFilters, SortSpec } from '@ulip/domain/contracts';

// ---------------------------------------------------------------- parser

test('parser fa: عمده‌فروشان قطعات پرینتر HP در تهران → businessType+specialty+brand+city (ZWNJ + mixed)', async () => {
  const p = new DeterministicQueryParser();
  const q = await p.parse({ text: 'عمده\u200cفروشان قطعات پرینتر HP در تهران', locale: 'fa' });
  assert.deepEqual(q.filters.businessTypes, ['Wholesaler']);
  assert.ok((q.filters.specialties ?? []).includes('Printer Parts'));
  assert.deepEqual(q.filters.brands, ['HP']);
  assert.equal(q.filters.city, 'Tehran');
  assert.equal(q.locale, 'mixed');
  assert.equal(q.parserKind, 'RULES_FALLBACK');
  assert.ok(q.confidence > 0.5);
});

test('parser en: wholesale printer parts suppliers → business type + specialty, brands untouched', async () => {
  const p = new DeterministicQueryParser();
  const q = await p.parse({ text: 'wholesale printer parts', locale: 'en' });
  assert.deepEqual(q.filters.businessTypes, ['Wholesaler']);
  assert.deepEqual(q.filters.industries, ['Printing']);
  assert.ok((q.filters.specialties ?? []).includes('Printer Parts'));
  assert.equal(q.locale, 'en');
});

test('parser: unmatched terms are reported honestly (no fabrication)', async () => {
  const p = new DeterministicQueryParser();
  const q = await p.parse({ text: 'کرم ضد آفتاب ویژه فروشگاه‌های زنجیره‌ای', locale: 'fa' });
  assert.equal(Object.keys(q.filters).length >= 1, true); // فروشگاه → Retailer-ish keyword
  assert.ok(q.unmatchedTerms.length > 0, 'unknown words must surface as unmatchedTerms');
  assert.ok(q.confidence < 0.8);
});

test('parser: SQL-injection text stays inert (no filters, unmatched only)', async () => {
  const p = new DeterministicQueryParser();
  const q = await p.parse({ text: "'; DROP TABLE leads; --", locale: 'en' });
  assert.ok(q.unmatchedTerms.length > 0 || Object.keys(q.filters).length === 0);
  assert.equal(q.filters.status, undefined);
  assert.equal(q.filters.businessTypes, undefined);
});

test('parser: status keyword maps to lifecycle value only when valid', async () => {
  const p = new DeterministicQueryParser();
  const q = await p.parse({ text: 'qualified leads in tehran', locale: 'en' });
  assert.equal(q.filters.status, 'QUALIFIED');
  assert.equal(q.filters.city, 'Tehran');
});

// ---------------------------------------------------------------- ranker

function row(partial: Partial<SearchRow>): SearchRow {
  return {
    id: partial.id ?? 'l1',
    businessId: 'b1',
    status: 'SCORED',
    canonicalName: 'Test Business',
    description: null,
    website: null,
    identities: [],
    city: 'Tehran',
    country: 'Iran',
    scores: null,
    matched: {
      businessType: false,
      industry: false,
      specialty: false,
      subSpecialty: false,
      brand: false,
      city: false,
      country: false,
      content: false,
      name: false,
    },
    contentMatches: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

test('ranker: baseline = priority when present, neutral 50 otherwise; reasons always present', () => {
  const noScores = rankRow(row({}));
  assert.equal(noScores.searchScore, 50);
  assert.equal(noScores.reasons[0]?.type, 'PRIORITY_BASELINE');

  const withPriority = rankRow(row({ scores: { relevance: 10, audienceQuality: 10, activity: 10, confidence: 10, priority: 70 } }));
  assert.equal(withPriority.searchScore, 70);
  assert.match(withPriority.reasons[0]?.detail ?? '', /priority score/);
});

test('ranker: matched dimensions add fixed boosts, 0..100 clamp, deterministic ordering', () => {
  const matched = rankRow(
    row({
      scores: { relevance: 60, audienceQuality: 60, activity: 70, confidence: 90, priority: 55 },
      matched: {
        businessType: true,
        industry: true,
        specialty: true,
        subSpecialty: false,
        brand: true,
        city: true,
        country: false,
        content: true,
        name: true,
      },
      contentMatches: ['HP printer parts wholesale'],
    }),
  );
  // 55 + 12 + 10 + 10 + 8 + 6 + 6 + 5 + 4 + 4 = 120 → clamped 100
  assert.equal(matched.searchScore, 100);
  const types = matched.reasons.map((r) => r.type);
  for (const expected of ['BUSINESS_TYPE_MATCH', 'INDUSTRY_MATCH', 'SPECIALTY_MATCH', 'BRAND_MATCH', 'CITY_MATCH', 'CONTENT_RELEVANCE', 'NAME_MATCH', 'ACTIVITY_MATCH', 'HIGH_CONFIDENCE'] as const) {
    assert.ok(types.includes(expected), `missing reason ${expected}`);
  }

  const a = row({ id: 'a', scores: { relevance: 1, audienceQuality: 1, activity: 1, confidence: 1, priority: 50 } });
  const b = row({
    id: 'b',
    scores: { relevance: 1, audienceQuality: 1, activity: 1, confidence: 1, priority: 50 },
    matched: { ...row({}).matched, name: true },
  });
  const ranked = rankRows([a, b], false);
  assert.equal(ranked[0]?.id, 'b', 'higher composite ranks first');
});

// ---------------------------------------------------------------- service

function taxonomyOf(_tenantId: string, _filters: LeadSearchFilters): ResolvedTaxonomy {
  return {
    businessTypes: [],
    industries: [],
    specialties: [],
    subSpecialties: [],
    terms: [],
    unresolved: [],
    city: null,
  };
}

function taxonomyResolver(): TaxonomyResolver {
  return { async resolve(t, f) { return taxonomyOf(t, f); } };
}

test('service: AI NOT_CONFIGURED ⇒ deterministic fallback parser used (honest parser kind)', async () => {
  let resolveCalls = 0;
  const svc = new SearchService({
    llm: null,
    taxonomy: {
      async resolve(_t, filters) {
        resolveCalls += 1;
        assert.equal((filters.specialties ?? []).length >= 0, true);
        return taxonomyOf(_t, filters);
      },
    },
    executor: {
      async search() {
        return { rows: [], total: 0 };
      },
    },
    planner: {
      async plan(input: { mode: string }) {
        void input;
        return { mode: 'EXISTING_ONLY' as const, steps: [], executed: false, note: 'no sources' };
      },
    },
  });
  const { response } = await svc.executeNaturalLanguage('t9', { text: 'عمده فروش قطعات پرینتر در تهران' });
  assert.equal(response.parser.kind, 'RULES_FALLBACK');
  assert.equal(response.locale, 'fa');
  assert.equal(resolveCalls, 1);
  assert.ok(response.execution.discoveryPlan.note.length > 0);
});

test('service: failing LLM falls back to rules parser (AI unavailable is honest, not fatal)', async () => {
  let warned: string | null = null;
  const svc = new SearchService({
    llm: {
      async parseSearchQuery() {
        throw new Error('provider down');
      },
    },
    taxonomy: taxonomyResolver(),
    executor: { async search() { return { rows: [], total: 0 }; } },
    planner: { async plan(i) { void i; return { mode: 'EXISTING_ONLY' as const, steps: [], executed: false, note: 'x' }; } },
    log: { info() { /* noop */ }, warn(msg: string) { warned = msg; } },
  });
  const { response } = await svc.executeNaturalLanguage('t1', { text: 'hello' });
  assert.equal(response.parser.kind, 'RULES_FALLBACK');
  assert.ok(warned !== null, 'fallback must be logged as a warning');
});

test('service: empty text rejected', async () => {
  const svc = new SearchService({
    llm: null,
    taxonomy: taxonomyResolver(),
    executor: { async search() { return { rows: [], total: 0 }; } },
    planner: { async plan(i) { void i; return { mode: 'EXISTING_ONLY' as const, steps: [], executed: false, note: 'x' }; } },
  });
  await assert.rejects(() => svc.executeNaturalLanguage('t1', { text: '   ' }), /text is required/);
});

test('service: structured entry reuses the same engine (executor filters composed)', async () => {
  const svc = new SearchService({
    llm: null,
    taxonomy: {
      async resolve(_t, filters) {
        // The resolver maps slug 'printer-parts' → tenant taxonomy node id.
        const ids = (filters.businessTypes ?? []).map((t) => (t === 'printer-parts' ? '22222222-2222-2222-2222-222222222222' : t));
        return {
          businessTypes: ids,
          industries: [],
          specialties: [],
          subSpecialties: [],
          terms: [{ field: 'businessTypes' as const, term: 'printer-parts', nodeId: ids[0] ?? null, via: 'SLUG' as const }],
          unresolved: [],
          city: null,
        };
      },
    },
    executor: {
      async search(_t, filters, pagination, sort) {
        assert.deepEqual(filters.businessTypeNodeIds, ['22222222-2222-2222-2222-222222222222']);
        assert.deepEqual(sort, [{ field: 'relevance', direction: 'DESC' } as SortSpec]);
        assert.equal(pagination.limit, 10);
        return { rows: [], total: 0 };
      },
    },
    planner: { async plan(i) { void i; return { mode: 'EXISTING_ONLY' as const, steps: [], executed: false, note: 'x' }; } },
  });
  const out = await svc.executeStructuredFromFilters(
    't1',
    { businessTypes: ['printer-parts'] },
    { page: 1, limit: 10 },
    [{ field: 'relevance', direction: 'DESC' }],
  );
  assert.equal(out.pagination.total, 0);
});

test('emptyStructuredQuery: canonical shape with default pagination', () => {
  const q = emptyStructuredQuery();
  assert.deepEqual(q.pagination, { page: 1, limit: 50 });
  assert.deepEqual(q.filters, {});
});
