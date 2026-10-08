/**
 * SearchService (Phase 20) — the orchestrator for both entry points:
 *
 *   natural-language search: text → parse → resolve → execute → rank → plan
 *   structured search:       filters → resolve → execute → rank
 *
 * Reuses `StructuredSearchQuery` from @ulip/domain as the ONLY query shape.
 * The plan step is ALWAYS attached (mode defaults to EXISTING_ONLY with honest
 * capability verdicts) so callers see what discovery could add.
 */

import type { LeadSearchFilters, SearchPagination, SortSpec, StructuredSearchQuery } from '@ulip/domain/contracts';
import type {
  DiscoveryPlan,
  ExecutionMode,
  NlSearchInput,
  QueryParser,
  ResolvedTaxonomy,
  SearchResponse,
  SearchServiceDeps,
  TaxonomyResolver,
} from './contracts.ts';
import { SearchInputError } from './contracts.ts';
import { DeterministicQueryParser } from './parser.ts';
import { rankRows } from './ranker.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT_LENGTH = 1000;

export function emptyStructuredQuery(filters: LeadSearchFilters = {}): StructuredSearchQuery {
  return { filters, pagination: { page: 1, limit: DEFAULT_LIMIT } };
}

/** Clamps pagination to sane bounds (page >= 1, limit 1..200). */
function clampPagination(p: SearchPagination | undefined): { page: number; limit: number } {
  const page = p?.page ?? 1;
  const limit = p?.limit ?? DEFAULT_LIMIT;
  return { page: Number.isInteger(page) && page > 0 ? page : 1, limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : DEFAULT_LIMIT };
}

export class SearchService {
  private readonly deps: SearchServiceDeps;
  private readonly fallbackParser: DeterministicQueryParser;

  constructor(deps: SearchServiceDeps) {
    this.deps = deps;
    this.fallbackParser = new DeterministicQueryParser();
  }

  /**
   * Full NL pipeline with explicit tenant scoping. Taxonomy resolution runs
   * through the configured deps (tenant-scoped) before execution.
   */
  async executeNaturalLanguage(
    tenantId: string,
    input: NlSearchInput,
  ): Promise<{ response: SearchResponse; discoveryPlan: DiscoveryPlan }> {
    const text = input.text.trim();
    if (text === '') throw new SearchInputError('text is required');
    if (text.length > MAX_TEXT_LENGTH) throw new SearchInputError(`text is too long (max ${MAX_TEXT_LENGTH} characters)`);
    const localeHint = input.locale === 'fa' || input.locale === 'en' ? input.locale : 'fa';

    const parsed = await this.parseWithFallback(text, localeHint);

    const structuredQuery = emptyStructuredQuery(parsed.filters);
    structuredQuery.pagination = clampPagination({ ...structuredQuery.pagination, ...(input.pagination ?? {}) });
    if (input.sort !== undefined && input.sort.length > 0) structuredQuery.sort = input.sort;

    const resolved = await this.deps.taxonomy.resolve(tenantId, structuredQuery.filters);

    const execution = await this.executeStructured(tenantId, structuredQuery, resolved, false);

    const mode: ExecutionMode = input.mode ?? 'EXISTING_ONLY';
    const structuredForPlan = { ...structuredQuery, filters: execution.filtersApplied };
    const discoveryPlan = await this.deps.planner.plan({
      tenantId,
      text,
      structuredQuery: structuredForPlan,
      resolved,
      mode,
      allowFake: input.allowFake === true,
      correlationId: input.correlationId,
    });

    return {
      response: {
        query: text,
        locale: parsed.locale,
        parser: {
          kind: parsed.parserKind,
          provider: parsed.parserProvider,
          modelVersion: parsed.parserModelVersion,
          confidence: parsed.confidence,
        },
        structuredQuery: { ...structuredQuery, filters: execution.filtersApplied },
        unmatchedTerms: parsed.unmatchedTerms,
        resolution: {
          terms: resolved.terms,
          unresolved: resolved.unresolved,
          city: resolved.city,
          contentTerms: execution.freeTextTerms,
        },
        execution: { mode, discoveryPlan },
        data: execution.data,
        pagination: execution.pagination,
      },
      discoveryPlan,
    };
  }

  /** Structured entry point (GET /leads with full filters; same engine). */
  async executeStructuredFromFilters(
    tenantId: string,
    filters: LeadSearchFilters,
    pagination: SearchPagination | undefined,
    sort: SortSpec[] | undefined,
  ): Promise<{ data: SearchResponse['data']; pagination: SearchResponse['pagination']; structuredQuery: StructuredSearchQuery; resolution: SearchResponse['resolution'] }> {
    const structuredQuery = emptyStructuredQuery(filters);
    structuredQuery.pagination = clampPagination({ ...structuredQuery.pagination, ...(pagination ?? {}) });
    if (sort !== undefined && sort.length > 0) structuredQuery.sort = sort;

    const resolved = await this.deps.taxonomy.resolve(tenantId, structuredQuery.filters);
    const execution = await this.executeStructured(tenantId, structuredQuery, resolved, true);
    return {
      data: execution.data,
      pagination: execution.pagination,
      structuredQuery: { ...structuredQuery, filters: execution.filtersApplied },
      resolution: {
        terms: resolved.terms,
        unresolved: resolved.unresolved,
        city: resolved.city,
        contentTerms: execution.freeTextTerms,
      },
    };
  }

  // ------------------------------------------------------------------ details

  private async parseWithFallback(text: string, localeHint: 'fa' | 'en') {
    if (this.deps.llm !== null) {
      try {
        const llmResult = await this.deps.llm.parseSearchQuery({ text, locale: localeHint });
        return {
          filters: this.sanitizeFilters(llmResult.filters),
          confidence: clamp01(llmResult.confidence),
          unmatchedTerms: stringArray(llmResult.unmatchedTerms).slice(0, 10),
          locale: localeHint,
          parserKind: 'LLM' as const,
          parserProvider: llmResult.meta.provider,
          parserModelVersion: llmResult.meta.modelVersion,
        };
      } catch (err) {
        this.deps.log?.warn('LLM parse failed; falling back to deterministic rules parser', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const fallback = await this.fallbackParser.parse({ text, locale: localeHint });
    return fallback;
  }

  /**
   * Untrusted LLM output → typed filter object: only known keys survive,
   * lists are capped string arrays, numbers are finite 0..100, status must be
   * a real lifecycle value. NEVER SQL — just typed filter fields.
   */
  private sanitizeFilters(raw: LeadSearchFilters): LeadSearchFilters {
    const out: LeadSearchFilters = {};
    const listKeys = ['businessTypes', 'industries', 'specialties', 'subSpecialties', 'brands'] as const;
    for (const key of listKeys) {
      const value: unknown = raw[key];
      if (Array.isArray(value)) {
        const cleaned = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().slice(0, 100)).filter((v) => v !== '');
        if (cleaned.length > 0) {
          (out as Record<string, unknown>)[key] = cleaned.slice(0, 10);
        }
      } else if (typeof value === 'string' && value.trim() !== '') {
        (out as Record<string, unknown>)[key] = [value.trim().slice(0, 100)];
      }
    }
    for (const key of ['city', 'country', 'sourceType'] as const) {
      const value: unknown = raw[key];
      if (typeof value === 'string' && value.trim() !== '') (out as Record<string, unknown>)[key] = value.trim().slice(0, 100);
    }
    const STATUS_VALUES: readonly string[] = [
      'DISCOVERED', 'RAW_STORED', 'NORMALIZED', 'DEDUP_CHECKED', 'ANALYSIS_PENDING',
      'ANALYZING', 'SCORED', 'REVIEW_REQUIRED', 'QUALIFIED', 'REJECTED', 'FAILED', 'ARCHIVED',
    ];
    const status: unknown = raw.status;
    if (typeof status === 'string' && (STATUS_VALUES as readonly string[]).includes(status)) {
      (out as Record<string, unknown>)['status'] = status;
    }
    for (const key of ['minRelevance', 'minAudienceQuality', 'minActivity', 'minConfidence'] as const) {
      const value: unknown = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        (out as Record<string, unknown>)[key] = Math.min(Math.max(value, 0), 100);
      }
    }
    return out;
  }

  private async executeStructured(
    tenantId: string,
    structuredQuery: StructuredSearchQuery,
    resolved: ResolvedTaxonomy,
    sortedInSql: boolean,
  ): Promise<{
    data: SearchResponse['data'];
    pagination: SearchResponse['pagination'];
    filtersApplied: LeadSearchFilters;
    freeTextTerms: string[];
  }> {
    const f = structuredQuery.filters;

    // Freed text from unresolved taxonomy terms falls back to content-aware
    // matching — honesty with utility: the term is reported unresolved AND
    // used as free text.
    const freeTextTerms = resolved.unresolved.slice(0, 5);

    const executorFilters = {
      businessTypeNodeIds: resolved.businessTypes,
      industryNodeIds: resolved.industries,
      specialtyNodeIds: resolved.specialties,
      subSpecialtyNodeIds: resolved.subSpecialties,
      brands: f.brands ?? [],
      city: resolved.city?.canonical ?? f.city ?? null,
      country: f.country ?? null,
      sourceType: f.sourceType ?? null,
      status: f.status ?? null,
      minRelevance: f.minRelevance ?? null,
      minAudienceQuality: f.minAudienceQuality ?? null,
      minActivity: f.minActivity ?? null,
      minConfidence: f.minConfidence ?? null,
      contentTerms: freeTextTerms,
    };

    const page = await this.deps.executor.search(
      tenantId,
      executorFilters,
      { page: structuredQuery.pagination.page ?? 1, limit: structuredQuery.pagination.limit ?? DEFAULT_LIMIT },
      structuredQuery.sort ?? [],
    );
    this.deps.log?.info('search executed', {
      tenantId,
      total: page.total,
      businessTypes: executorFilters.businessTypeNodeIds.length,
      industries: executorFilters.industryNodeIds.length,
      brands: executorFilters.brands.length,
      contentTerms: executorFilters.contentTerms.length,
    });

    return {
      data: rankRows(page.rows, sortedInSql),
      pagination: {
        page: structuredQuery.pagination.page ?? 1,
        limit: structuredQuery.pagination.limit ?? DEFAULT_LIMIT,
        total: page.total,
        totalPages: Math.max(1, Math.ceil(page.total / (structuredQuery.pagination.limit ?? DEFAULT_LIMIT))),
      },
      filtersApplied: { ...f },
      freeTextTerms,
    };
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}
