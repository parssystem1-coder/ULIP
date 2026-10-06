/**
 * Content intelligence (Phase 18, ADR-030 §8–§11).
 *
 * Cross-content reasoning over the sampled items + profile evidence:
 *  - keyword signals matched over EVERY sampled item (repeated independent
 *    evidence strengthens confidence — each hit contributes a distinct piece
 *    of evidence with its own id);
 *  - profile-vs-content consistency (AGREE / PARTIAL / CONFLICT /
 *    INSUFFICIENT_CONTENT) — content that contradicts the profile must never
 *    silently produce a high-confidence classification;
 *  - per-item content relevance against the requested search criteria;
 *  - content-derived activity signals (recency, cadence, recent count) that
 *    never infer growth and never use follower counts alone.
 *
 * Determinism: fixed dictionaries, aliasKey normalization (Persian variants +
 * ZWNJ, ADR-019), stable ordering everywhere. No AI inside this module —
 * these are the deterministic signals layer beneath the LLM/Vision steps.
 */

import { aliasKey } from '@ulip/domain';
import type { EvidenceDraft } from './contracts.ts';
import type { SampledContent } from './sampling.ts';
import type { NormalizedContent } from './content.ts';
import { deterministicUuid, sha256Hex } from './ids.ts';

// ---------------------------------------------------------------------------
// Keyword signal dictionaries (deterministic; mirrored in docs/ai/AI.md)
// ---------------------------------------------------------------------------

export interface KeywordRule {
  code: string;
  keywords: readonly string[];
  /** Dimension this signal speaks to (informational; confidence math is separate). */
  dimension: 'businessType' | 'industry' | 'specialty' | 'commercial';
}

const BUSINESS_TYPE_RULES: readonly KeywordRule[] = [
  { code: 'BT_WHOLESALE', dimension: 'businessType', keywords: ['wholesale', 'wholesaler', 'عمده فروش', 'عمده‌فروش', 'bulk price'] },
  { code: 'BT_DISTRIBUTION', dimension: 'businessType', keywords: ['distributor', 'distribution', 'پخش', 'توزیع'] },
  { code: 'BT_MANUFACTURING', dimension: 'businessType', keywords: ['manufacturer', 'manufacturing', 'production', 'تولیدی', 'تولید'] },
  { code: 'BT_SERVICE', dimension: 'businessType', keywords: ['service', 'appointment', 'booking', 'خدمات', 'رزرو'] },
  { code: 'BT_RETAIL', dimension: 'businessType', keywords: ['retail', 'shop', 'store', 'فروشگاه', 'فروش'] },
];

const COMMERCIAL_RULES: readonly KeywordRule[] = [
  { code: 'CI_WHOLESALE_INTENT', dimension: 'commercial', keywords: ['wholesale', 'عمده', 'bulk', 'tat'], },
  { code: 'CI_PRICE_LIST', dimension: 'commercial', keywords: ['price list', 'لیست قیمت', 'قیمت', 'price'] },
  { code: 'CI_ORDER_INTENT', dimension: 'commercial', keywords: ['order', 'سفارش', 'available', 'موجود'] },
];

/** Repeated-evidence signal: each independent hit strengthens confidence. */
export interface AggregatedSignal {
  code: string;
  dimension: KeywordRule['dimension'];
  /** Evidence ids (CAPTION_TEXT evidence per matching content item). */
  evidenceIds: string[];
  /** Distinct content items supporting this signal. */
  hitCount: number;
  /** hitCount-scaled confidence: 0.55 + 0.08·(hits−1), capped at 0.9. */
  confidence: number;
}

function normalizeText(text: string): string {
  return aliasKey(text);
}

function hitsFor(sampled: readonly SampledContent[], keywords: readonly string[]): { items: NormalizedContent[] } {
  const items: NormalizedContent[] = [];
  for (const s of sampled) {
    const haystacks = [s.content.text ?? '', s.content.hashtags.join(' ')];
    const normalizedHaystack = normalizeText(haystacks.join(' '));
    if (keywords.some((k) => normalizedHaystack.includes(normalizeText(k)))) items.push(s.content);
  }
  return { items };
}

/**
 * Resolves a lead_contents id to the CAPTION_TEXT evidence id that cites it.
 * Provided by the flow once evidence drafts exist; identity is the fallback so
 * the signals remain valid (as source-content references) even without a run.
 */
export type EvidenceIdResolver = (contentId: string) => string | null;

/**
 * Aggregates keyword signals across all sampled content. Each matching item
 * contributes its own evidence id — "printer parts" backed by 3 captions is
 * stronger (and separately citable) than one.
 */
export function aggregateSignals(
  sampled: readonly SampledContent[],
  evidenceIdOf?: EvidenceIdResolver,
): AggregatedSignal[] {
  const out: AggregatedSignal[] = [];
  for (const rule of [...BUSINESS_TYPE_RULES, ...COMMERCIAL_RULES]) {
    const { items } = hitsFor(sampled, rule.keywords);
    if (items.length === 0) continue;
    const confidence = Math.min(0.9, 0.55 + 0.08 * (items.length - 1));
    out.push({
      code: rule.code,
      dimension: rule.dimension,
      evidenceIds: items.map((c) => evidenceIdOf?.(c.contentId) ?? c.contentId),
      hitCount: items.length,
      confidence,
    });
  }
  return out.sort((a, b) => b.hitCount - a.hitCount || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Content evidence drafts (source_reference = lead_contents/{id}#signal)
// ---------------------------------------------------------------------------

/**
 * Builds CAPTION_TEXT evidence drafts from sampled content so every
 * conclusion can reference content evidence records (§6). One draft per
 * sampled item with text; the id is deterministic per (analysis, content).
 */
export function buildContentEvidenceDrafts(
  leadId: string,
  analysisId: string,
  sampled: readonly SampledContent[],
): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  for (const s of sampled) {
    const c = s.content;
    const text = c.text ?? `[${c.contentType} item without caption text]`;
    const sourceReference = `lead_contents/${c.contentId}`;
    const contentHash = sha256Hex(`${c.contentHash}|${text}`);
    drafts.push({
      id: deterministicUuid('evidence', analysisId, 'CAPTION_TEXT', sourceReference, contentHash),
      leadId,
      evidenceType: 'CAPTION_TEXT',
      sourceType: 'PLATFORM',
      sourceReference,
      content: text,
      contentHash,
      retrievedAt: c.retrievedAt,
      confidence: 0.9,
      metadata: {
        contentId: c.contentId,
        contentType: c.contentType,
        publishedAt: c.publishedAt,
        hashtags: c.hashtags.join(','),
        selectionReasons: s.reasons.join(','),
      },
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Profile-vs-content consistency (§9)
// ---------------------------------------------------------------------------

export type ConsistencySignal =
  | 'PROFILE_CONTENT_AGREE'
  | 'PROFILE_CONTENT_PARTIAL'
  | 'PROFILE_CONTENT_CONFLICT'
  | 'INSUFFICIENT_CONTENT';

export interface ConsistencyResult {
  signal: ConsistencySignal;
  confidence: number;
  /** Normalized profile topic keys that found support in content. */
  supported: string[];
  /** Normalized profile topic keys with NO content support. */
  unsupported: string[];
  /** Content signals that contradict the profile topics. */
  contradictions: string[];
  evidenceIds: string[];
}

/**
 * Profile topic terms: from canonical name + description (bio) — the "profile"
 * side of profile-vs-content. Persian-aware normalization.
 */
export function profileTopicTerms(profileText: string | null): string[] {
  if (profileText === null || profileText.trim() === '') return [];
  const words = aliasKey(profileText)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && w.length <= 40);
  return [...new Set(words)];
}

/**
 * Structured profile-vs-content consistency. With no/insufficient text
 * content the result is INSUFFICIENT_CONTENT — never a silent agree.
 *
 * Semantics:
 *  - <2 text items or no profile terms → INSUFFICIENT_CONTENT
 *  - support ratio ≥ 0.5 and no contradictions → AGREE
 *  - some support, or contradictions ≤ half of supported → PARTIAL
 *  - contradictions dominate (≥ half of profile terms) → CONFLICT
 */
export function computeConsistency(
  profileTerms: readonly string[],
  sampled: readonly SampledContent[],
  aggregated: readonly AggregatedSignal[],
  evidenceIdOf?: EvidenceIdResolver,
): ConsistencyResult {
  const textItems = sampled.filter((s) => s.content.text !== null);
  if (textItems.length < 2 || profileTerms.length === 0) {
    return {
      signal: 'INSUFFICIENT_CONTENT',
      confidence: 0.3,
      supported: [],
      unsupported: [...profileTerms],
      contradictions: [],
      evidenceIds: [],
    };
  }

  const perItem = textItems.map((s) => normalizeText(s.content.text ?? ''));
  const evidenceByContent = new Map<string, string>();
  for (const s of textItems) evidenceByContent.set(s.content.contentId, s.content.contentId);

  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const term of profileTerms) {
    const key = normalizeText(term);
    const hit = perItem.some((t) => t.includes(key));
    if (hit) supported.push(term);
    else unsupported.push(term);
  }

  // Contradiction detection: content signals of a DIFFERENT business type than
  // the profile's. Determined per profile business-type term: if the profile
  // contains a business-type keyword and content strongly shows a different
  // one (supported by ≥2 items), that is a contradiction.
  const contradictions: string[] = [];
  const profileBt = BUSINESS_TYPE_RULES.find((r) =>
    r.keywords.some((k) => normalizeText(profileTerms.join(' ')).includes(normalizeText(k))),
  );
  if (profileBt !== undefined) {
    for (const rule of BUSINESS_TYPE_RULES) {
      if (rule.code === profileBt.code) continue;
      const { items } = hitsFor(sampled, rule.keywords);
      if (items.length >= 2) contradictions.push(rule.code);
    }
  }

  const supportRatio = supported.length / profileTerms.length;
  const evidenceIds = textItems
    .filter((s) => supported.length > 0 && s.content.text !== null)
    .slice(0, 10)
    .map((s) => evidenceIdOf?.(s.content.contentId) ?? evidenceByContent.get(s.content.contentId) ?? s.content.contentId);

  let signal: ConsistencySignal;
  let confidence: number;
  if (contradictions.length > 0 && contradictions.length >= Math.max(1, supported.length)) {
    signal = 'PROFILE_CONTENT_CONFLICT';
    confidence = Math.max(0.3, 0.7 - 0.1 * contradictions.length);
  } else if (supportRatio >= 0.5 && contradictions.length === 0) {
    signal = 'PROFILE_CONTENT_AGREE';
    confidence = Math.min(0.95, 0.7 + 0.05 * supported.length);
  } else if (supported.length > 0 || aggregated.length > 0) {
    signal = 'PROFILE_CONTENT_PARTIAL';
    confidence = 0.5 + 0.05 * supported.length;
  } else {
    signal = 'INSUFFICIENT_CONTENT';
    confidence = 0.3;
  }

  return { signal, confidence, supported, unsupported, contradictions, evidenceIds };
}

// ---------------------------------------------------------------------------
// Content relevance (§11)
// ---------------------------------------------------------------------------

export interface ContentRelevance {
  /** 0..1 aggregated across sampled items (null when no criteria given). */
  overall: number | null;
  perItem: { contentId: string; relevance: number; signals: string[] }[];
}

/**
 * Per-item relevance against the requested search criteria (deterministic
 * keyword coverage). A "Happy New Year" post matches nothing and contributes
 * ~0; "HP LaserJet fuser available" against "HP printer parts" matches
 * strongly. With no criteria, relevance is null (not fabricated).
 */
export function computeContentRelevance(
  criteria: string | null,
  sampled: readonly SampledContent[],
): ContentRelevance {
  if (criteria === null || criteria.trim() === '') {
    return { overall: null, perItem: [] };
  }
  const terms = criteria
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => aliasKey(t))
    .filter((t) => t.length >= 3);
  const uniqueTerms = [...new Set(terms)];

  const perItem = sampled.map((s) => {
    const haystack = normalizeText(
      [s.content.text ?? '', s.content.hashtags.join(' '), s.content.contentType].join(' '),
    );
    const signals: string[] = [];
    let hits = 0;
    for (const t of uniqueTerms) {
      if (haystack.includes(t)) {
        hits += 1;
        signals.push(`matched:${t}`);
      }
    }
    const relevance = uniqueTerms.length === 0 ? 0 : Math.min(1, hits / uniqueTerms.length);
    return { contentId: s.content.contentId, relevance, signals };
  });

  const withText = perItem.filter((p) => p.relevance !== null);
  const overall =
    withText.length === 0
      ? 0
      : Math.round(
          (withText.reduce((sum, p) => sum + (p.relevance ?? 0), 0) / withText.length) * 10_000,
        ) / 10_000;
  return { overall, perItem };
}

// ---------------------------------------------------------------------------
// Activity intelligence (§10)
// ---------------------------------------------------------------------------

export interface ActivitySignals {
  /** Newest published content age in days (null when unknown). */
  newestAgeDays: number | null;
  /** Oldest sampled content age in days (null when unknown). */
  oldestAgeDays: number | null;
  /** Number of items published within the last 30 days. */
  recentCount30d: number;
  /** Median gap in days between consecutive publications (null when <2 dates). */
  cadenceDays: number | null;
  /** Content-derived activity score contribution 0..100. */
  score: number;
  /** Structured reasons (codes + evidence ids), no chain-of-thought. */
  reasons: { code: string; message: string; evidenceIds: string[] }[];
}

/**
 * Content-derived activity signals. Uses ONLY publication behavior of actual
 * content items — follower counts never contribute here (§21 non-goals), and
 * no growth claim is ever produced: the output is descriptive, not predictive.
 */
export function computeActivitySignals(
  sampled: readonly SampledContent[],
  now: Date,
  evidenceIdOf?: EvidenceIdResolver,
): ActivitySignals {
  const dated = sampled
    .map((s) => ({ c: s.content, t: s.content.publishedAt !== null ? Date.parse(s.content.publishedAt) : Number.NaN }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t);

  const evidenceIds = sampled
    .map((s) => evidenceIdOf?.(s.content.contentId) ?? s.content.contentId);
  const reasons: ActivitySignals['reasons'] = [];

  if (dated.length === 0) {
    return {
      newestAgeDays: null,
      oldestAgeDays: null,
      recentCount30d: 0,
      cadenceDays: null,
      score: 0,
      reasons: [
        {
          code: 'ACTIVITY_CONTENT_UNAVAILABLE',
          message: 'no dated content available — activity cannot be asserted from content',
          evidenceIds: [],
        },
      ],
    };
  }

  const day = 86_400_000;
  const nowMs = now.getTime();
  const newestAgeDays = Math.max(0, Math.round((nowMs - (dated[0]?.t ?? nowMs)) / day));
  const oldestAgeDays = Math.max(0, Math.round((nowMs - (dated[dated.length - 1]?.t ?? nowMs)) / day));
  const recentCount30d = dated.filter((x) => nowMs - x.t <= 30 * day).length;

  const gaps: number[] = [];
  for (let i = 0; i + 1 < dated.length; i++) {
    const newer = dated[i]?.t ?? 0;
    const older = dated[i + 1]?.t ?? 0;
    gaps.push((newer - older) / day);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const cadenceDays =
    sortedGaps.length === 0
      ? null
      : Math.round((sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0) * 10) / 10;

  let score = 0;
  if (newestAgeDays <= 14) {
    score += 40;
    reasons.push({ code: 'ACTIVITY_RECENT_PUBLISH', message: `newest content ${newestAgeDays}d old`, evidenceIds });
  } else if (newestAgeDays <= 60) {
    score += 25;
    reasons.push({ code: 'ACTIVITY_MODERATE_PUBLISH', message: `newest content ${newestAgeDays}d old`, evidenceIds });
  } else {
    score += 5;
    reasons.push({ code: 'ACTIVITY_STALE_PUBLISH', message: `newest content ${newestAgeDays}d old`, evidenceIds });
  }
  if (recentCount30d >= 3) {
    score += 30;
    reasons.push({ code: 'ACTIVITY_CADENCE_ACTIVE', message: `${recentCount30d} items in the last 30 days`, evidenceIds });
  } else if (recentCount30d >= 1) {
    score += 15;
    reasons.push({ code: 'ACTIVITY_CADENCE_SPARSE', message: `${recentCount30d} item(s) in the last 30 days`, evidenceIds });
  }
  if (cadenceDays !== null && cadenceDays <= 21) {
    score += 20;
    reasons.push({ code: 'ACTIVITY_CONSISTENT_CADENCE', message: `median gap ${cadenceDays}d`, evidenceIds });
  }
  if (sampled.length >= 5) {
    score += 10;
    reasons.push({ code: 'ACTIVITY_VOLUME', message: `${sampled.length} sampled content items`, evidenceIds });
  }

  return {
    newestAgeDays,
    oldestAgeDays,
    recentCount30d,
    cadenceDays,
    score: Math.min(100, score),
    reasons,
  };
}
