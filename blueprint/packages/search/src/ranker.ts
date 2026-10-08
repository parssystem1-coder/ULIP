/**
 * Deterministic ranker (Phase 20).
 *
 * Composite search score = policy baseline (current priority → relevance →
 * neutral 50) + fixed boosts per matched dimension, clamped to 0..100. Every
 * adjustment emits a structured reason — explanations are deterministic and
 * auditable, no chain-of-thought, no AI involvement at rank time.
 */

import type { RankedLead, SearchReason, SearchRow } from './contracts.ts';

/** Fixed, documented boost weights (deterministic, never tuned at runtime). */
const BOOSTS = {
  BUSINESS_TYPE_MATCH: 12,
  INDUSTRY_MATCH: 10,
  SPECIALTY_MATCH: 10,
  SUB_SPECIALTY_MATCH: 8,
  BRAND_MATCH: 8,
  CITY_MATCH: 6,
  COUNTRY_MATCH: 3,
  CONTENT_RELEVANCE: 6,
  NAME_MATCH: 5,
  ACTIVITY_MATCH: 4,
  HIGH_CONFIDENCE: 4,
} as const;

const ACTIVITY_THRESHOLD = 60;
const CONFIDENCE_THRESHOLD = 85; // 0..100 scale (confidence_score column)

function baselineOf(row: SearchRow): { value: number; reason: SearchReason } {
  const priority = row.scores?.priority ?? null;
  const relevance = row.scores?.relevance ?? null;
  const base = priority ?? relevance ?? 50;
  const source = priority !== null ? 'priority score' : relevance !== null ? 'relevance score (no priority yet)' : 'no scores yet (neutral baseline)';
  return { value: base, reason: { type: 'PRIORITY_BASELINE', detail: `baseline from ${source}: ${base}` } };
}

export function rankRow(row: SearchRow): RankedLead {
  const reasons: SearchReason[] = [];
  const { value: baseline, reason: baselineReason } = baselineOf(row);
  reasons.push(baselineReason);

  let score = baseline;

  const add = (type: SearchReason['type'], boost: number, detail: string): void => {
    score += boost;
    reasons.push({ type, detail });
  };

  if (row.matched.businessType) add('BUSINESS_TYPE_MATCH', BOOSTS.BUSINESS_TYPE_MATCH, 'lead business type matches the requested Business Type');
  if (row.matched.industry) add('INDUSTRY_MATCH', BOOSTS.INDUSTRY_MATCH, 'lead industry matches the requested industry');
  if (row.matched.specialty) add('SPECIALTY_MATCH', BOOSTS.SPECIALTY_MATCH, 'lead specialty matches the requested specialty');
  if (row.matched.subSpecialty) add('SUB_SPECIALTY_MATCH', BOOSTS.SUB_SPECIALTY_MATCH, 'lead sub-specialty matches the requested sub-specialty');
  if (row.matched.brand) add('BRAND_MATCH', BOOSTS.BRAND_MATCH, 'lead carries a matching brand classification');
  if (row.matched.city) add('CITY_MATCH', BOOSTS.CITY_MATCH, 'lead location matches the requested city');
  if (row.matched.country && !row.matched.city) add('COUNTRY_MATCH', BOOSTS.COUNTRY_MATCH, 'lead location matches the requested country');
  if (row.matched.content) {
    add('CONTENT_RELEVANCE', BOOSTS.CONTENT_RELEVANCE, `content text matches the free-text terms (${row.contentMatches.length} snippet(s) attached)`);
  }
  if (row.matched.name) {
    add('NAME_MATCH', BOOSTS.NAME_MATCH, 'business name/description matches the free-text terms');
  }
  if ((row.scores?.activity ?? 0) >= ACTIVITY_THRESHOLD) {
    add('ACTIVITY_MATCH', BOOSTS.ACTIVITY_MATCH, `activity score ${row.scores?.activity} >= ${ACTIVITY_THRESHOLD}`);
  }
  if ((row.scores?.confidence ?? 0) >= CONFIDENCE_THRESHOLD) {
    add('HIGH_CONFIDENCE', BOOSTS.HIGH_CONFIDENCE, `analysis confidence ${row.scores?.confidence} >= ${CONFIDENCE_THRESHOLD}`);
  }

  const searchScore = Math.max(0, Math.min(100, Math.round(score * 100) / 100));

  return {
    id: row.id,
    businessId: row.businessId,
    status: row.status,
    canonicalName: row.canonicalName,
    description: row.description,
    website: row.website,
    identities: row.identities,
    city: row.city,
    country: row.country,
    scores: row.scores,
    searchScore,
    reasons,
    contentMatches: row.contentMatches,
    createdAt: row.createdAt,
  };
}

/** Ranks rows and orders the page deterministically when no explicit sort was given. */
export function rankRows(rows: readonly SearchRow[], sortedInSql: boolean): RankedLead[] {
  const ranked = rows.map(rankRow);
  if (sortedInSql) return ranked;
  return ranked.sort((a, b) => {
    if (b.searchScore !== a.searchScore) return b.searchScore - a.searchScore;
    const pa = a.scores?.priority ?? -1;
    const pb = b.scores?.priority ?? -1;
    if (pb !== pa) return pb - pa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
