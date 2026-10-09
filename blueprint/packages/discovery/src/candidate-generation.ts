/**
 * Phase 21 — Deterministic candidate generation & constraint classification.
 *
 * PURE modules: no network, no DB, no LLM at runtime. The LLM may PROPOSE
 * aliases upstream, but everything here is decided deterministically so a
 * discovery plan is replayable and auditable (no fabricated hashtags).
 *
 * Candidate generation: taxonomy node → canonical aliases (slug, name,
 * alias_norm) → Persian normalization → hashtag normalization → duplicate
 * removal → deterministic ranking (source order, then lexicographic) → top N.
 *
 * Constraint classification: each user constraint must be labeled with WHERE
 * it is enforced and HOW exact it is. Honesty rule (ADR-027): anything that
 * cannot be proven is UNPROVABLE and stays visible in the plan — never
 * silently dropped, never presented as an exact filter.
 */

import { aliasKey, unifyPersianCharacters } from '@ulip/domain';
// Local alias to dodge the instagram.ts/hashtag-budget.ts re-export clash;
// the budget variant (ZWNJ/kashida → underscore) is the dedupe identity used
// by the ledger, so candidate generation must agree with it.
import { normalizeHashtag as normalizeHashtagBudget } from './hashtag-budget.ts';
const normalizeHashtag = normalizeHashtagBudget;

// ---------------------------------------------------------------------------
// Deterministic hashtag candidate generation
// ---------------------------------------------------------------------------

export interface TaxonomyAliasInput {
  /** e.g. 'وکیل خانواده' (node display name) */
  name: string;
  slug: string;
  /** alias_norm values from taxonomy_node_aliases (may be empty). */
  aliases: string[];
}

export interface HashtagCandidate {
  hashtag: string;
  /** Which taxonomy surface produced it (slug | name | alias:<norm>). */
  via: string;
  rank: number;
}

/**
 * Pure slug→hashtag conversion: latin-safe. Persian slugs become underscored
 * hashtags; ZWNJ variants collapse through normalizeHashtag.
 */
export function hashtagsFromTaxonomy(node: TaxonomyAliasInput, max: number): HashtagCandidate[] {
  const surfaces: { via: string; raw: string }[] = [
    { via: 'slug', raw: node.slug },
    { via: 'name', raw: node.name },
    ...node.aliases.map((a) => ({ via: `alias:${aliasKey(a)}`, raw: a })),
  ];
  const seen = new Set<string>();
  const out: HashtagCandidate[] = [];
  for (const s of surfaces) {
    const tag = normalizeHashtag(s.raw);
    if (tag === '' || tag.length < 2) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ hashtag: tag, via: s.via, rank: out.length + 1 });
    if (out.length >= max) break;
  }
  return out;
}

/** Deterministic top-N selection: keeps input order (already ranked), bounded. */
export function selectHashtags(candidates: HashtagCandidate[], max: number): { selected: HashtagCandidate[]; skipped: HashtagCandidate[] } {
  return { selected: candidates.slice(0, Math.max(0, max)), skipped: candidates.slice(Math.max(0, max)) };
}

// ---------------------------------------------------------------------------
// Constraint classification (honest enforcement map)
// ---------------------------------------------------------------------------

/** Where a user constraint is enforced in the discovery pipeline. */
export type ConstraintEnforcement =
  | 'API_DIRECT' // the Graph API itself can evaluate it
  | 'POST_FETCH_FILTER' // exact check on fetched numeric data (ULIP side)
  | 'POST_FETCH_HEURISTIC' // heuristic on fetched data (documented as heuristic)
  | 'AI_ANALYSIS' // needs AI analysis of bio/content (evidence-based)
  | 'UNPROVABLE'; // cannot be proven from available authorized data

export type ConstraintExactness = 'exact' | 'heuristic' | 'evidence-based' | 'unprovable';

export interface ClassifiedConstraint {
  raw: string;
  kind: ConstraintEnforcement;
  exactness: ConstraintExactness;
  /** Human-readable note shown verbatim in the DiscoveryPlan. */
  note: string;
}

/** A numeric threshold constraint, e.g. followers >= 5000. */
export interface NumericThreshold {
  field: 'followers' | 'mediaCount';
  op: '>=' | '>';
  value: number;
}

/**
 * Classifies one natural-language constraint string. Deterministic pattern
 * matching on the normalized text — the LLM may propose the split upstream,
 * but this classifier is the decision point.
 */
export function classifyConstraint(raw: string): ClassifiedConstraint {
  const text = raw.trim();
  // Persian/Arabic-Indic digits → ASCII first, so numeric thresholds match.
  const key = aliasKey(unifyPersianCharacters(text));

  // followers/فالوور + numeric threshold → exact post-fetch filter.
  // Note: aliasKey normalizes ئ→ی, so فالوئر/فالوور/فالویر all collapse to
  // «فالویر» — the pattern matches the normalized forms. The number may sit
  // BEFORE («5000 followers») or AFTER («حداقل 5000 فالوئر») the keyword.
  const followerMatch =
    key.match(/(?:followers?|فالویر|فالوور|دنبال کننده)[^\d]*(\d{3,})/) ??
    key.match(/(\d{3,})[^\w]*\s*(?:followers?|فالویر|فالوور|دنبال کننده)/);
  if (followerMatch !== null) {
    const value = Number(followerMatch[1]);
    return {
      raw: text,
      kind: 'POST_FETCH_FILTER',
      exactness: 'exact',
      note: `followers_count >= ${value} — checked exactly on business_discovery data after fetch`,
    };
  }

  // activity / فعال → heuristic on latest media timestamp
  if (/(?:active|فعال|آخرین پست|recent)/.test(key) === true && /(?:فعال|active)/.test(key)) {
    return {
      raw: text,
      kind: 'POST_FETCH_HEURISTIC',
      exactness: 'heuristic',
      note: 'activity — heuristic: latest media timestamp within N days (configurable); never presented as exact',
    };
  }

  // city → AI analysis (Graph API exposes no address via these surfaces)
  if (/(?:تهران|tehran|شیراز|مشهد|اصفهان|کرج|تبریز|اراک)/.test(key) || /(?:city|شهر)/.test(key)) {
    return {
      raw: text,
      kind: 'AI_ANALYSIS',
      exactness: 'evidence-based',
      note: 'location — evidence-based via AI analysis of biography/content (the Graph API exposes no address fields on these surfaces)',
    };
  }

  // profession/specialty semantics → AI analysis
  if (/(?:وکیل|lawyer|پزشک|doctor|آرایشگاه|فروشگاه|تولیدکننده|توزیع)/.test(key)) {
    return {
      raw: text,
      kind: 'AI_ANALYSIS',
      exactness: 'evidence-based',
      note: 'profession/specialty — evidence-based via AI analysis of biography/content against the taxonomy',
    };
  }

  // Default honesty: unprovable, stays visible in the plan.
  return {
    raw: text,
    kind: 'UNPROVABLE',
    exactness: 'unprovable',
    note: 'cannot be proven from authorized API data — shown for transparency, never applied as a filter',
  };
}

/** Post-fetch threshold extracted from a constraint string, if any. */
export function extractNumericThreshold(raw: string): NumericThreshold | null {
  const c = classifyConstraint(raw);
  if (c.kind !== 'POST_FETCH_FILTER') return null;
  const m = c.raw.match(/(\d{3,})/);
  if (m === null) return null;
  return { field: 'followers', op: '>=', value: Number(m[1]) };
}

/**
 * Classifies a LIST of constraint strings for one DiscoveryPlanStep —
 * dedupes by normalized key, bounded to 10 entries, preserves input order.
 * This is the entry point the planner calls; the single-string version above
 * is the per-item decision unit (kept pure + independently testable).
 */
export function classifyConstraints(raws: string[]): ClassifiedConstraint[] {
  const seen = new Set<string>();
  const out: ClassifiedConstraint[] = [];
  for (const raw of raws) {
    const text = raw.trim();
    if (text === '') continue;
    const k = aliasKey(text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(classifyConstraint(text));
    if (out.length >= 10) break;
  }
  return out;
}
