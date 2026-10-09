/**
 * Search contracts (Phase 20) — Natural Language Search & Search Execution.
 *
 * Reuses the EXISTING domain contracts (`LeadSearchFilters`,
 * `StructuredSearchQuery`, `SearchPagination`, `SortSpec`) — no second search
 * contract. Adds only what execution needs:
 *
 *   text → ParsedQuery → validated filters → taxonomy resolution →
 *   parameterized SQL execution → deterministic ranking + reasons →
 *   optional capability-aware discovery plan.
 *
 * Safety rules:
 *  - The LLM is UNTRUSTED: its output is sanitized into `LeadSearchFilters`
 *    and never becomes SQL text — only bound parameters do.
 *  - Ranking is deterministic and explainable: every score adjustment carries
 *    a structured reason (no chain-of-thought).
 *  - Discovery planning is capability-aware and honest: sources whose
 *    connector cannot serve the query are reported UNSUPPORTED/PARTIAL,
 *    never silently attempted.
 */

import type { LeadSearchFilters, SearchPagination, SortSpec, StructuredSearchQuery } from '@ulip/domain/contracts';
import type {
  ClassifiedConstraint,
  HashtagCandidate,
  HashtagBudgetSnapshot,
} from '@ulip/discovery';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Which parser produced the structured query — honesty about the source. */
export type SearchParserKind = 'LLM' | 'RULES_FALLBACK';

export interface ParsedQuery {
  /** Raw typed filters (labels / slugs / aliases / node ids) — pre-resolution. */
  filters: LeadSearchFilters;
  confidence: number; // 0..1
  unmatchedTerms: string[];
  /**
   * Literal matched phrases for content-aware matching (deterministic parser
   * only: the raw keywords that fired, e.g. "قطعات پرینتر"). The LLM parser
   * has no literal surface, so it emits [] — resolved labels + unresolved
   * terms still reach the content path via the service.
   */
  contentTerms: string[];
  locale: 'fa' | 'en' | 'mixed';
  parserKind: SearchParserKind;
  parserProvider: string;
  parserModelVersion: string;
}

/** Parses NL text into a typed query. `null` means NOT_CONFIGURED. */
export interface QueryParser {
  parse(input: { text: string; locale: string }): Promise<ParsedQuery>;
}

// ---------------------------------------------------------------------------
// Taxonomy resolution
// ---------------------------------------------------------------------------

export type TaxonomyField = 'businessTypes' | 'industries' | 'specialties' | 'subSpecialties';

export type ResolutionVia = 'ID' | 'SLUG' | 'NAME' | 'ALIAS' | 'UNRESOLVED';

export interface ResolvedTerm {
  field: TaxonomyField;
  /** The filter term exactly as parsed (before resolution). */
  term: string;
  /** Taxonomy node id; null when the term matched nothing (honest gap). */
  nodeId: string | null;
  via: ResolutionVia;
}

export interface ResolvedTaxonomy {
  /** Resolved taxonomy node ids per field (unresolved terms excluded). */
  businessTypes: string[];
  industries: string[];
  specialties: string[];
  subSpecialties: string[];
  /** Resolution trail for explanations/debugging. */
  terms: ResolvedTerm[];
  /** Terms that matched no taxonomy node (never silently dropped). */
  unresolved: string[];
  /** Canonical city resolved via location_aliases, when available. */
  city: { raw: string; canonical: string; country: string | null } | null;
}

export interface TaxonomyResolver {
  resolve(tenantId: string, filters: LeadSearchFilters): Promise<ResolvedTaxonomy>;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Filters as the executor consumes them (post-resolution). */
export interface ExecutorFilters {
  businessTypeNodeIds: string[];
  industryNodeIds: string[];
  specialtyNodeIds: string[];
  subSpecialtyNodeIds: string[];
  brands: string[];
  city: string | null;
  country: string | null;
  sourceType: string | null;
  status: string | null;
  minRelevance: number | null;
  minAudienceQuality: number | null;
  minActivity: number | null;
  minConfidence: number | null;
  /**
   * Content-aware OR-path terms: literal matched keywords, parsed brands,
   * unresolved terms AND resolved taxonomy labels. These never filter a lead
   * out on their own — they open a content-based match path alongside the
   * structured taxonomy filters (a business with a generic profile but
   * relevant posts still matches). Untrusted → bound parameters only.
   */
  contentTerms: string[];
}

export interface SearchRow {
  id: string;
  businessId: string;
  status: string;
  canonicalName: string;
  description: string | null;
  website: string | null;
  createdAt: string;
  identities: { sourceType: string; externalId: string; username: string | null; profileUrl: string | null }[];
  city: string | null;
  country: string | null;
  scores: {
    relevance: number | null;
    audienceQuality: number | null;
    activity: number | null;
    confidence: number | null;
    priority: number | null;
  } | null;
  /** Per-dimension match flags computed in SQL (deterministic). */
  matched: {
    businessType: boolean;
    industry: boolean;
    specialty: boolean;
    subSpecialty: boolean;
    brand: boolean;
    city: boolean;
    country: boolean;
    content: boolean;
    name: boolean;
  };
  /** Snippets of content that matched the free-text terms (bounded). */
  contentMatches: string[];
}

export interface SearchPage {
  rows: SearchRow[];
  total: number;
}

export interface SearchExecutor {
  search(
    tenantId: string,
    filters: ExecutorFilters,
    pagination: { page: number; limit: number },
    sort: SortSpec[],
  ): Promise<SearchPage>;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type SearchReasonType =
  | 'BUSINESS_TYPE_MATCH'
  | 'INDUSTRY_MATCH'
  | 'SPECIALTY_MATCH'
  | 'SUB_SPECIALTY_MATCH'
  | 'BRAND_MATCH'
  | 'CITY_MATCH'
  | 'COUNTRY_MATCH'
  | 'CONTENT_RELEVANCE'
  | 'NAME_MATCH'
  | 'ACTIVITY_MATCH'
  | 'HIGH_CONFIDENCE'
  | 'PRIORITY_BASELINE';

export interface SearchReason {
  type: SearchReasonType;
  detail: string;
}

/** One lead in the response: scores + deterministic search score + reasons. */
export interface RankedLead {
  id: string;
  businessId: string;
  status: string;
  canonicalName: string;
  description: string | null;
  website: string | null;
  identities: SearchRow['identities'];
  city: string | null;
  country: string | null;
  scores: SearchRow['scores'];
  /** 0..100 deterministic composite: baseline score + per-dimension boosts. */
  searchScore: number;
  reasons: SearchReason[];
  contentMatches: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Discovery planning (capability-aware, honest)
// ---------------------------------------------------------------------------

export type ExecutionMode = 'EXISTING_ONLY' | 'DISCOVER_WHEN_SUPPORTED';

export type DiscoveryVerdict = 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED';

/** Plan-visible candidate (the discovery package's deterministic shape). */
export type HashtagCandidateInfo = HashtagCandidate;
/** Plan-visible classified constraint (POST_FETCH_FILTER / AI_ANALYSIS / ...). */
export type ClassifiedConstraintInfo = ClassifiedConstraint;
/** Plan-visible rolling-window budget snapshot. */
export type HashtagBudgetInfo = HashtagBudgetSnapshot;

export interface DiscoveryPlanStep {
  sourceId: string;
  sourceType: string;
  sourceName: string;
  sourceStatus: string;
  connectorResolution: 'RESOLVED' | 'UNKNOWN_SOURCE_TYPE' | 'NOT_CONFIGURED' | 'UNSUPPORTED';
  isDeterministicFake: boolean;
  verdict: DiscoveryVerdict;
  /** Honest, human-readable reason for the verdict. */
  reason: string;
  /** Derived discovery query when the source can serve one (hashtag/username/text). */
  proposedQuery?: string | undefined;
  proposedFilters?: Record<string, string> | undefined;
  /**
   * Phase 21: when the step proposes TAXONOMY-derived hashtag candidates
   * (PARTIAL hashtag suggestion), this carries the deterministic candidate
   * list with per-candidate provenance and rank (no LLM, replayable).
   */
  hashtagCandidates?: HashtagCandidateInfo[] | undefined;
  /**
   * Phase 21: where each user constraint will be enforced and how exact it
   * is — visible in the plan, never silently dropped (honesty map).
   */
  classifiedConstraints?: ClassifiedConstraintInfo[] | undefined;
  /**
   * Phase 21: official rolling-7d hashtag budget snapshot for this source
   * (30 unique tags / 7d per professional account, Meta quota).
   */
  hashtagBudget?: HashtagBudgetInfo | undefined;
}

export interface DiscoveryPlan {
  mode: ExecutionMode;
  steps: DiscoveryPlanStep[];
  /** true when a step was auto-executed (mode=DISCOVER_WHEN_SUPPORTED only). */
  executed: boolean;
  jobId?: string | undefined;
  /** Overall honest note (always present). */
  note: string;
}

export interface PlannerSource {
  id: string;
  /** Tenant id of the source row (registry requires tenant-scoped records). */
  tenantId: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
}

export interface PlannerDeps {
  listSources(tenantId: string): Promise<PlannerSource[]>;
  /**
   * Phase 21: alias surfaces (alias_norm values) for resolved taxonomy node
   * ids — deterministic hashtag candidates come from these, never from the LLM.
   */
  taxonomyAliases?(nodeIds: string[]): Promise<{ nodeId: string; name: string; slug: string; aliases: string[] }[]>;
  /**
   * Enqueues a discovery job for the chosen source; returns the persistent job id.
   * `allowFake` MUST be preserved into the persisted job payload when true —
   * the worker refuses deterministic fake connectors unless the job payload
   * itself carries `allowFake: true` (Phase 20.1: planner verdict and job
   * payload must agree on the same value).
   */
  enqueueDiscovery(input: {
    tenantId: string;
    sourceId: string;
    query?: string | undefined;
    filters?: Record<string, string> | undefined;
    allowFake?: boolean | undefined;
    correlationId?: string | undefined;
  }): Promise<{ jobId: string }>;
}

export interface DiscoveryPlanner {
  plan(input: {
    tenantId: string;
    text: string;
    structuredQuery: StructuredSearchQuery;
    resolved: ResolvedTaxonomy;
    mode: ExecutionMode;
    allowFake: boolean;
    correlationId?: string | undefined;
  }): Promise<DiscoveryPlan>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface NlSearchInput {
  text: string;
  locale?: string | undefined;
  mode?: ExecutionMode | undefined;
  /** Explicit opt-in for executing a deterministic-fake discovery source. */
  allowFake?: boolean | undefined;
  pagination?: SearchPagination | undefined;
  sort?: SortSpec[] | undefined;
  correlationId?: string | undefined;
}

export interface SearchPaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SearchResponse {
  /** Echo of the original query text (NL search) or null (structured search). */
  query: string | null;
  locale: string;
  parser: {
    kind: SearchParserKind;
    provider: string;
    modelVersion: string;
    confidence: number;
  };
  structuredQuery: StructuredSearchQuery;
  unmatchedTerms: string[];
  resolution: {
    terms: ResolvedTerm[];
    unresolved: string[];
    city: ResolvedTaxonomy['city'];
    /** Terms that became free-text content matching. */
    contentTerms: string[];
  };
  execution: {
    mode: ExecutionMode;
    discoveryPlan: DiscoveryPlan;
  };
  data: RankedLead[];
  pagination: SearchPaginationResult;
}

export interface SearchServiceDeps {
  /** LLM parser when AI is READY; null ⇒ deterministic rules fallback. */
  llm: { parseSearchQuery(input: { text: string; locale: string }): Promise<{ filters: LeadSearchFilters; confidence: number; unmatchedTerms: string[]; meta: { provider: string; modelVersion: string } }> } | null;
  taxonomy: TaxonomyResolver;
  executor: SearchExecutor;
  planner: DiscoveryPlanner;
  log?: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void } | undefined;
}

/** Raised when the query cannot be executed as typed (e.g. text missing). */
export class SearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchInputError';
  }
}
