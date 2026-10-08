/**
 * Search executor (Phase 20) — the ONLY place NL/structured search becomes SQL.
 *
 * Every filter value is a bound parameter (no string interpolation of user
 * input — the LLM is untrusted and never reaches this layer as text). Filter
 * terms are escaped for LIKE wildcards and wrapped in parameter arrays.
 * Tenant scoping is unconditional. SQL text is built from fixed fragments
 * only; values always travel as $n parameters.
 */

import type { Database } from '@ulip/runtime';
import type { SortSpec } from '@ulip/domain/contracts';
import type { ExecutorFilters, SearchExecutor, SearchPage, SearchRow } from './contracts.ts';

const MAX_CONTENT_TERMS = 5;
const MAX_LIST_ITEMS = 25;
const MAX_TERM_LENGTH = 100;

/** Escapes LIKE/ILIKE wildcards so user terms match literally. */
function likePattern(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `%${escaped}%`;
}

/**
 * Strips NUL bytes: PostgreSQL rejects strings containing U+0000, so a
 * hostile payload could otherwise turn into a 500. NULs can never appear in
 * real data, so removing them is semantically a no-op.
 */
function stripNuls(value: string): string {
  return value.split('\u0000').join('');
}

function cleanTerms(values: readonly string[] | undefined, max: number): string[] {
  if (values === undefined) return [];
  const out: string[] = [];
  for (const v of values) {
    const t = stripNuls(String(v)).trim().slice(0, MAX_TERM_LENGTH);
    if (t !== '' && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const SORT_COLUMNS: Readonly<Record<SortSpec['field'], string>> = {
  relevance: 'sc.relevance_score',
  priority: 'sc.priority_score',
  activity: 'sc.activity_score',
  audienceQuality: 'sc.audience_quality_score',
  createdAt: 'l.created_at',
};

const SELECT_COLUMNS = `
  SELECT l.id, l.business_id, l.status::text AS status, l.created_at,
         b.canonical_name, b.description, b.website,
         COALESCE(idn.identities, '[]'::json) AS identities,
         loc.city, loc.country,
         sc.relevance_score, sc.audience_quality_score, sc.activity_score,
         sc.confidence_score, sc.priority_score,
         COALESCE(cm.matches, ARRAY[]::text[]) AS content_matches`;

export class DbSearchExecutor implements SearchExecutor {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async search(
    tenantId: string,
    filters: ExecutorFilters,
    pagination: { page: number; limit: number },
    sort: SortSpec[],
  ): Promise<SearchPage> {
    const params: unknown[] = [tenantId];
    const where: string[] = ['l.tenant_id = $1'];
    // All nine match flags are ALWAYS emitted (FALSE when the dimension was
    // not filtered) so the ranker can produce a stable explanation set.
    const flags: Record<string, string> = {
      businessType: 'FALSE AS matched_business_type',
      industry: 'FALSE AS matched_industry',
      specialty: 'FALSE AS matched_specialty',
      subSpecialty: 'FALSE AS matched_sub_specialty',
      brand: 'FALSE AS matched_brand',
      city: 'FALSE AS matched_city',
      country: 'FALSE AS matched_country',
      content: 'FALSE AS matched_content',
      name: 'FALSE AS matched_name',
    };
    const setFlag = (key: string, sql: string): void => {
      flags[key] = sql;
    };
    const pushArray = (values: readonly string[]): string => `$${params.push([...values])}`;

    // -- taxonomy node id filters ------------------------------------------
    const businessTypes = filters.businessTypeNodeIds.slice(0, MAX_LIST_ITEMS);
    const industries = filters.industryNodeIds.slice(0, MAX_LIST_ITEMS);
    const specialties = filters.specialtyNodeIds.slice(0, MAX_LIST_ITEMS);
    const subSpecialties = filters.subSpecialtyNodeIds.slice(0, MAX_LIST_ITEMS);
    const brands = cleanTerms(filters.brands, MAX_LIST_ITEMS);
    const contentTerms = cleanTerms(filters.contentTerms, MAX_CONTENT_TERMS);

    if (businessTypes.length > 0) {
      const p = pushArray(businessTypes);
      where.push(`b.business_type_node_id = ANY(${p}::uuid[])`);
      setFlag('businessType', `(b.business_type_node_id = ANY(${p}::uuid[])) AS matched_business_type`);
    }
    if (industries.length > 0) {
      const p = pushArray(industries);
      where.push(`b.industry_node_id = ANY(${p}::uuid[])`);
      setFlag('industry', `(b.industry_node_id = ANY(${p}::uuid[])) AS matched_industry`);
    }
    if (specialties.length > 0) {
      const p = pushArray(specialties);
      const cond = `EXISTS (SELECT 1 FROM lead_classifications lc WHERE lc.lead_id = l.id AND lc.classification_type = 'SPECIALTY' AND lc.taxonomy_node_id = ANY(${p}::uuid[]))`;
      where.push(cond);
      setFlag('specialty', `${cond} AS matched_specialty`);
    }
    if (subSpecialties.length > 0) {
      const p = pushArray(subSpecialties);
      const cond = `EXISTS (SELECT 1 FROM lead_classifications lc WHERE lc.lead_id = l.id AND lc.classification_type = 'SUB_SPECIALTY' AND lc.taxonomy_node_id = ANY(${p}::uuid[]))`;
      where.push(cond);
      setFlag('subSpecialty', `${cond} AS matched_sub_specialty`);
    }

    // -- brand free-text over lead_classifications (BRAND) ------------------
    if (brands.length > 0) {
      const p = pushArray(brands.map(likePattern));
      const cond = `EXISTS (SELECT 1 FROM lead_classifications lc WHERE lc.lead_id = l.id AND lc.classification_type = 'BRAND' AND (lc.value_text ILIKE ANY(${p}) OR lc.value_normalized ILIKE ANY(${p})))`;
      where.push(cond);
      setFlag('brand', `${cond} AS matched_brand`);
    }

    // -- location ------------------------------------------------------------
    const city = filters.city === null ? '' : stripNuls(filters.city).trim().slice(0, MAX_TERM_LENGTH);
    const country = filters.country === null ? '' : stripNuls(filters.country).trim().slice(0, MAX_TERM_LENGTH);
    if (city !== '') {
      const p = pushArray([likePattern(city)]);
      const cond = `EXISTS (SELECT 1 FROM business_locations bl WHERE bl.business_id = b.id AND bl.city ILIKE ANY(${p}))`;
      where.push(cond);
      setFlag('city', `${cond} AS matched_city`);
    }
    if (country !== '') {
      const p = pushArray([likePattern(country)]);
      const cond = `EXISTS (SELECT 1 FROM business_locations bl WHERE bl.business_id = b.id AND bl.country ILIKE ANY(${p}))`;
      where.push(cond);
      setFlag('country', `${cond} AS matched_country`);
    }

    // -- source type / status ------------------------------------------------
    if (filters.sourceType !== null && stripNuls(filters.sourceType).trim() !== '') {
      const p = pushArray([stripNuls(filters.sourceType).trim().slice(0, MAX_TERM_LENGTH)]);
      where.push(
        `EXISTS (SELECT 1 FROM lead_identities li JOIN sources s ON s.id = li.source_id WHERE li.lead_id = l.id AND s.type::text = ANY(${p}))`,
      );
    }
    if (filters.status !== null && stripNuls(filters.status).trim() !== '') {
      const p = pushArray([stripNuls(filters.status).trim()]);
      where.push(`l.status::text = ANY(${p})`);
    }

    // -- current-score thresholds (NULL scores never pass) -------------------
    for (const [filterKey, column] of [
      ['minRelevance', 'sc.relevance_score'],
      ['minAudienceQuality', 'sc.audience_quality_score'],
      ['minActivity', 'sc.activity_score'],
      ['minConfidence', 'sc.confidence_score'],
    ] as const) {
      const value = filters[filterKey];
      if (value !== null) {
        params.push(value);
        where.push(`${column} >= $${params.length}`);
      }
    }

    // -- content-aware free text (name/description/content) ------------------
    let contentPatternsParam: string | null = null;
    if (contentTerms.length > 0) {
      const p = pushArray(contentTerms.map(likePattern));
      contentPatternsParam = p;
      where.push(
        `(b.canonical_name ILIKE ANY(${p}) OR b.description ILIKE ANY(${p}) OR EXISTS (SELECT 1 FROM lead_contents c WHERE c.lead_id = l.id AND c.text ILIKE ANY(${p})))`,
      );
      setFlag('name', `(b.canonical_name ILIKE ANY(${p}) OR b.description ILIKE ANY(${p})) AS matched_name`);
      setFlag('content', `EXISTS (SELECT 1 FROM lead_contents c WHERE c.lead_id = l.id AND c.text ILIKE ANY(${p})) AS matched_content`);
    }

    const whereSql = where.join('\n    AND ');
    const flagSql = `,\n         ${Object.values(flags).join(',\n         ')}`;
    const limit = Math.min(Math.max(pagination.limit, 1), 200);
    const offset = (Math.max(pagination.page, 1) - 1) * limit;
    const orderBy = this.orderBy(sort);

    const cmJoin =
      contentPatternsParam !== null
        ? `LEFT JOIN LATERAL (
      SELECT array_agg(x.txt) AS matches FROM (
        SELECT left(c.text, 160) AS txt FROM lead_contents c
        WHERE c.lead_id = l.id AND c.text ILIKE ANY(${contentPatternsParam})
        ORDER BY c.published_at DESC NULLS LAST LIMIT 3
      ) x
    ) cm ON TRUE`
        : `LEFT JOIN LATERAL (SELECT NULL::text[] AS matches) cm ON TRUE`;

    const rowsSql = `${SELECT_COLUMNS}${flagSql}
    FROM leads l
    JOIN businesses b ON b.id = l.business_id AND b.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT relevance_score, audience_quality_score, activity_score, confidence_score, priority_score
      FROM lead_scores ls WHERE ls.lead_id = l.id AND ls.is_current = TRUE LIMIT 1
    ) sc ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object(
               'sourceType', x.source_type, 'externalId', x.external_id,
               'username', x.username, 'profileUrl', x.profile_url)), '[]'::json) AS identities
      FROM (
        SELECT li.source_id, s.type::text AS source_type, li.external_id, li.username, li.profile_url
        FROM lead_identities li JOIN sources s ON s.id = li.source_id
        WHERE li.lead_id = l.id ORDER BY li.created_at LIMIT 10
      ) x
    ) idn ON TRUE
    LEFT JOIN LATERAL (
      SELECT bl.city, bl.country FROM business_locations bl WHERE bl.business_id = b.id
      ORDER BY bl.created_at LIMIT 1
    ) loc ON TRUE
    ${cmJoin}
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

    const countSql = `
    SELECT count(*)::int AS total
    FROM leads l
    JOIN businesses b ON b.id = l.business_id AND b.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT relevance_score, audience_quality_score, activity_score, confidence_score, priority_score
      FROM lead_scores ls WHERE ls.lead_id = l.id AND ls.is_current = TRUE LIMIT 1
    ) sc ON TRUE
    WHERE ${whereSql}`;

    const [rowsResult, countResult] = await Promise.all([
      this.db.query<RawRow>(rowsSql, params),
      this.db.query<{ total: number }>(countSql, params),
    ]);
    return { rows: rowsResult.rows.map(mapRow), total: countResult.rows[0]?.total ?? 0 };
  }

  private orderBy(sort: SortSpec[]): string {
    const parts: string[] = [];
    for (const s of sort.slice(0, 3)) {
      const col = SORT_COLUMNS[s.field];
      if (col === undefined) continue;
      parts.push(`${col} ${s.direction === 'ASC' ? 'ASC' : 'DESC'} NULLS LAST`);
    }
    if (parts.length === 0) parts.push('sc.priority_score DESC NULLS LAST');
    parts.push('l.id ASC'); // deterministic tiebreaker
    return parts.join(', ');
  }
}

// ---------------------------------------------------------------------------
// Row mapping (snake_case SQL → typed contracts)
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  business_id: string;
  status: string;
  created_at: string | Date;
  canonical_name: string;
  description: string | null;
  website: string | null;
  identities: unknown;
  city: string | null;
  country: string | null;
  relevance_score: string | null;
  audience_quality_score: string | null;
  activity_score: string | null;
  confidence_score: string | null;
  priority_score: string | null;
  matched_business_type: boolean;
  matched_industry: boolean;
  matched_specialty: boolean;
  matched_sub_specialty: boolean;
  matched_brand: boolean;
  matched_city: boolean;
  matched_country: boolean;
  matched_content: boolean;
  matched_name: boolean;
  content_matches: string[] | null;
}

function numeric(v: string | null): number | null {
  return v === null ? null : Number(v);
}

function identitiesOf(v: unknown): SearchRow['identities'] {
  if (!Array.isArray(v)) return [];
  const out: SearchRow['identities'] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    out.push({
      sourceType: typeof r['sourceType'] === 'string' ? r['sourceType'] : '',
      externalId: typeof r['externalId'] === 'string' ? r['externalId'] : '',
      username: typeof r['username'] === 'string' ? r['username'] : null,
      profileUrl: typeof r['profileUrl'] === 'string' ? r['profileUrl'] : null,
    });
  }
  return out;
}

function mapRow(r: RawRow): SearchRow {
  const hasScores = r.relevance_score !== null || r.priority_score !== null;
  return {
    id: r.id,
    businessId: r.business_id,
    status: r.status,
    canonicalName: r.canonical_name,
    description: r.description,
    website: r.website,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    identities: identitiesOf(r.identities),
    city: r.city,
    country: r.country,
    scores: hasScores
      ? {
          relevance: numeric(r.relevance_score),
          audienceQuality: numeric(r.audience_quality_score),
          activity: numeric(r.activity_score),
          confidence: numeric(r.confidence_score),
          priority: numeric(r.priority_score),
        }
      : null,
    matched: {
      businessType: r.matched_business_type === true,
      industry: r.matched_industry === true,
      specialty: r.matched_specialty === true,
      subSpecialty: r.matched_sub_specialty === true,
      brand: r.matched_brand === true,
      city: r.matched_city === true,
      country: r.matched_country === true,
      content: r.matched_content === true,
      name: r.matched_name === true,
    },
    contentMatches: Array.isArray(r.content_matches) ? r.content_matches.filter((s): s is string => typeof s === 'string') : [],
  };
}
