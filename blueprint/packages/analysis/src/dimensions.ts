import type { FieldPrediction, StructuredProfile } from '@ulip/ai';
import type { ScoreDimensionInput } from '@ulip/scoring';
import type {
  EvidenceDraft,
  LeadContext,
  ScoreReason,
  UncertainField,
} from './contracts.ts';
import type { ActivitySignals, ConsistencyResult, ContentRelevance } from './intel.ts';

/** Phase 18 content signals folded into the deterministic dimensions. */
export interface ContentDimensionSignals {
  consistency: ConsistencyResult;
  relevance: ContentRelevance;
  activity: ActivitySignals;
}

export interface DimensionComputationInput {
  profile: StructuredProfile;
  evidence: readonly EvidenceDraft[];
  context: LeadContext;
  /** Present when the lead had content to analyze (Phase 18). */
  content?: ContentDimensionSignals | undefined;
}

export interface DimensionResult {
  dimensions: ScoreDimensionInput;
  reasons: ScoreReason[];
  uncertain: UncertainField[];
}

function isClaimed(p: FieldPrediction | undefined): p is FieldPrediction {
  return p !== undefined && p.availability !== 'UNAVAILABLE' && p.evidenceIds.length > 0;
}

function clamp100(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

function idsFor(evidence: readonly EvidenceDraft[], type: EvidenceDraft['evidenceType']): string[] {
  return evidence.filter((e) => e.evidenceType === type).map((e) => e.id);
}

/**
 * Deterministic dimension scoring (0..100 each, independent).
 * WEIGHTS and THRESHOLDS come from the persisted scoring policy — never from
 * this module. Every contribution produces a structured reason with the
 * evidence ids that support it (explainability, no chain-of-thought).
 */
export function computeDimensions(input: DimensionComputationInput): DimensionResult {
  const { profile, evidence, context, content } = input;
  const reasons: ScoreReason[] = [];
  const uncertain: UncertainField[] = [];

  // ---------------------------------------------------------------- relevance
  let relevance = 0;
  const add = (delta: number, reason: Omit<ScoreReason, 'delta' | 'dimension'>): void => {
    relevance += delta;
    reasons.push({ ...reason, dimension: 'relevance', delta: Math.round(delta * 100) / 100 });
  };
  if (isClaimed(profile.businessType)) {
    add(35 * profile.businessType.confidence, {
      code: 'RELEVANCE_BUSINESS_TYPE',
      message: `Business type detected (${profile.businessType.value})`,
      evidenceIds: profile.businessType.evidenceIds,
    });
  }
  if (isClaimed(profile.industry)) {
    add(25 * profile.industry.confidence, {
      code: 'RELEVANCE_INDUSTRY',
      message: `Industry detected (${profile.industry.value})`,
      evidenceIds: profile.industry.evidenceIds,
    });
  }
  const claimedSpecialties = profile.specialties.filter(isClaimed);
  if (claimedSpecialties.length > 0) {
    const avg = claimedSpecialties.reduce((s, p) => s + p.confidence, 0) / claimedSpecialties.length;
    add(20 * avg, {
      code: 'RELEVANCE_SPECIALTY',
      message: `${claimedSpecialties.length} specialty signal(s) matched`,
      evidenceIds: claimedSpecialties.flatMap((p) => p.evidenceIds),
    });
  }
  const claimedBrands = (profile.brands ?? []).filter(isClaimed);
  if (claimedBrands.length > 0) {
    add(5 * (claimedBrands[0]?.confidence ?? 0), {
      code: 'RELEVANCE_BRAND',
      message: `Brand identified (${claimedBrands.map((b) => b.value).join(', ')})`,
      evidenceIds: claimedBrands.flatMap((p) => p.evidenceIds),
    });
  }
  if (isClaimed(profile.city)) {
    add(15 * profile.city.confidence, {
      code: 'RELEVANCE_LOCATION',
      message: `Location detected (${profile.city.value})`,
      evidenceIds: profile.city.evidenceIds,
    });
  }
  const hintTypes = new Set(
    context.existingClassifications.filter((c) => c.source !== 'AI').map((c) => c.classificationType),
  );
  if (hintTypes.size > 0 && isClaimed(profile.businessType)) {
    add(5, {
      code: 'RELEVANCE_HINT_AGREEMENT',
      message: 'Discovery hints and AI classification agree on the business model',
      evidenceIds: idsFor(evidence, 'PROFILE_METADATA').slice(0, 1),
    });
  }
  // Phase 18: aggregated content relevance vs the requested search criteria.
  if (content !== undefined && content.relevance.overall !== null) {
    const overall = content.relevance.overall;
    const matched = content.relevance.perItem.filter((p) => p.relevance >= 0.5);
    const matchedIds = matched.map((p) => p.contentId);
    if (overall >= 0.5) {
      add(10 * overall, {
        code: 'RELEVANCE_CONTENT_MATCH',
        message: `Sampled content matches the search criteria (${Math.round(overall * 100)}%)`,
        evidenceIds: matchedIds,
      });
    } else {
      add(-10 * (1 - overall), {
        code: 'RELEVANCE_CONTENT_MISMATCH',
        message: `Sampled content barely matches the search criteria (${Math.round(overall * 100)}%)`,
        evidenceIds: matchedIds,
      });
    }
  }

  // ---------------------------------------------------------- audienceQuality
  let audienceQuality = 0;
  const aq = (delta: number, code: string, message: string, ids: string[]): void => {
    audienceQuality += delta;
    reasons.push({ dimension: 'audienceQuality', code, message, delta, evidenceIds: ids });
  };
  const bioIds = idsFor(evidence, 'BIO_TEXT');
  if (bioIds.length > 0) aq(20, 'AQ_BIO_PRESENT', 'Profile has a bio/description', bioIds);
  const siteEvidence = evidence.filter((e) => (e.content ?? '').startsWith('website:'));
  if (siteEvidence.length > 0) aq(15, 'AQ_WEBSITE_PRESENT', 'Website/contact URL present', siteEvidence.map((e) => e.id));
  const contactEvidence = evidence.filter((e) => (e.content ?? '').startsWith('contact channel available'));
  if (contactEvidence.length > 0) aq(15, 'AQ_CONTACT_PRESENT', 'Contact channel present', contactEvidence.map((e) => e.id));
  if (isClaimed(profile.businessType) || evidence.some((e) => (e.content ?? '').startsWith('category: '))) {
    aq(15, 'AQ_CATEGORY_PRESENT', 'Business category/type is known',
      isClaimed(profile.businessType) ? profile.businessType.evidenceIds : idsFor(evidence, 'PROFILE_METADATA').slice(0, 1));
  }
  const locIds = idsFor(evidence, 'LOCATION_SIGNAL');
  if (locIds.length > 0) aq(15, 'AQ_LOCATION_PRESENT', 'Structured location present', locIds);
  const identityEvidence = evidence.filter((e) => (e.content ?? '').includes('username:') || (e.content ?? '').includes('name: '));
  if (identityEvidence.length > 0) aq(10, 'AQ_IDENTITY_PRESENT', 'Source identity is complete', identityEvidence.map((e) => e.id));
  const mediaIds = [...idsFor(evidence, 'CONTENT_METADATA'), ...idsFor(evidence, 'CAPTION_TEXT')];
  if (mediaIds.length > 0) aq(10, 'AQ_CONTENT_PRESENT', 'Media/content samples present', mediaIds);

  // ----------------------------------------------------------------- activity
  const activity = computeActivity(evidence, context, reasons, content?.activity);

  // --------------------------------------------------------------- confidence
  let confidence = computeConfidence(profile, evidence, reasons);
  if (content?.consistency.signal === 'PROFILE_CONTENT_CONFLICT') {
    confidence = clamp100(confidence - 15);
    reasons.push({
      dimension: 'confidence',
      code: 'CONF_PROFILE_CONTENT_CONFLICT',
      message: 'Content contradicts the profile — confidence reduced, review recommended',
      delta: -15,
      evidenceIds: content.consistency.evidenceIds,
    });
  }

  // ------------------------------------------------- explicitly uncertain
  const pushIfUncertain = (field: string, p: FieldPrediction | undefined): void => {
    if (p === undefined) return;
    if (p.availability === 'AVAILABLE') return;
    uncertain.push({
      field,
      value: p.value,
      reason:
        p.availability === 'UNAVAILABLE'
          ? 'no supporting evidence reference — not used as a fact'
          : `availability ${p.availability} — inference, not confirmed`,
    });
  };
  pushIfUncertain('businessType', profile.businessType);
  pushIfUncertain('industry', profile.industry);
  profile.specialties.forEach((s, i) => pushIfUncertain(`specialties[${i}]`, s));
  (profile.brands ?? []).forEach((b, i) => pushIfUncertain(`brands[${i}]`, b));
  pushIfUncertain('city', profile.city);

  return {
    dimensions: {
      relevance: clamp100(relevance),
      audienceQuality: clamp100(audienceQuality),
      activity,
      confidence,
    },
    reasons,
    uncertain,
  };
}

function computeActivity(
  evidence: readonly EvidenceDraft[],
  context: LeadContext,
  reasons: ScoreReason[],
  contentActivity?: ActivitySignals | undefined,
): number {
  // Phase 18: content-derived signals dominate when dated content exists —
  // publishing recency/cadence, never follower counts alone, never growth claims.
  const contentUsable =
    contentActivity !== undefined &&
    contentActivity.reasons.length > 0 &&
    !contentActivity.reasons.some((r) => r.code === 'ACTIVITY_CONTENT_UNAVAILABLE');
  if (contentUsable && contentActivity !== undefined) {
    let score = contentActivity.score;
    for (const r of contentActivity.reasons) {
      reasons.push({
        dimension: 'activity',
        code: r.code,
        message: r.message,
        delta: r.code === 'ACTIVITY_RECENT_PUBLISH' ? 40 : r.code === 'ACTIVITY_CADENCE_ACTIVE' ? 30 : 0,
        evidenceIds: r.evidenceIds,
      });
    }
    // Engagement metadata is a secondary additive signal, capped low so a
    // follower count can never dominate (or replace) publishing evidence.
    const engagement = evidence.find((e) => e.evidenceType === 'ENGAGEMENT_SIGNAL');
    if (engagement !== undefined) {
      const followers = Number(engagement.metadata['followers'] ?? 0);
      const delta = followers >= 10_000 ? 10 : followers >= 1_000 ? 7 : followers >= 100 ? 4 : 0;
      if (delta > 0) {
        score += delta;
        reasons.push({
          dimension: 'activity',
          code: 'ACTIVITY_ENGAGEMENT_SECONDARY',
          message: `Engagement metadata observed (${followers} followers) — secondary signal`,
          delta,
          evidenceIds: [engagement.id],
        });
      }
    }
    return clamp100(score);
  }

  let score = 0;
  const captions = evidence.filter((e) => e.evidenceType === 'CAPTION_TEXT');
  if (captions.length >= 5) score += 60;
  else if (captions.length >= 3) score += 45;
  else if (captions.length >= 1) score += 25;
  if (captions.length > 0) {
    reasons.push({
      dimension: 'activity',
      code: 'ACTIVITY_CONTENT_VOLUME',
      message: `${captions.length} content sample(s) observed`,
      delta: captions.length >= 5 ? 60 : captions.length >= 3 ? 45 : 25,
      evidenceIds: captions.map((c) => c.id),
    });
  }
  const engagement = evidence.find((e) => e.evidenceType === 'ENGAGEMENT_SIGNAL');
  if (engagement !== undefined) {
    const followers = Number(engagement.metadata['followers'] ?? 0);
    let delta = 0;
    if (followers >= 10_000) delta = 25;
    else if (followers >= 1_000) delta = 18;
    else if (followers >= 100) delta = 10;
    else if (followers > 0) delta = 5;
    score += delta;
    if (delta > 0) {
      reasons.push({
        dimension: 'activity',
        code: 'ACTIVITY_ENGAGEMENT',
        message: `Engagement signal observed (${followers} followers)`,
        delta,
        evidenceIds: [engagement.id],
      });
    }
  }
  const published = context.contents
    .map((c) => (c.publishedAt !== null ? Date.parse(c.publishedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (published.length > 0) {
    const newest = Math.max(...published);
    const ageDays = (Date.now() - newest) / 86_400_000;
    const delta = ageDays <= 30 ? 15 : ageDays <= 180 ? 8 : 0;
    score += delta;
    if (delta > 0) {
      reasons.push({
        dimension: 'activity',
        code: 'ACTIVITY_RECENCY',
        message: `Recent content observed (${Math.round(ageDays)}d ago)`,
        delta,
        evidenceIds: idsFor(evidence, 'CONTENT_METADATA'),
      });
    }
  }
  if (score === 0) {
    reasons.push({
      dimension: 'activity',
      code: 'NO_ACTIVITY_SIGNALS',
      message: 'No activity signals available — activity cannot be asserted',
      delta: 0,
      evidenceIds: [],
    });
  }
  return clamp100(score);
}

function computeConfidence(
  profile: StructuredProfile,
  evidence: readonly EvidenceDraft[],
  reasons: ScoreReason[],
): number {
  if (evidence.length === 0) {
    reasons.push({
      dimension: 'confidence',
      code: 'NO_EVIDENCE',
      message: 'No evidence persisted — data confidence is 0',
      delta: 0,
      evidenceIds: [],
    });
    return 0;
  }
  const claimed = [
    ...(isClaimed(profile.businessType) ? [profile.businessType] : []),
    ...(isClaimed(profile.industry) ? [profile.industry] : []),
    ...profile.specialties.filter(isClaimed),
    ...(isClaimed(profile.city) ? [profile.city] : []),
  ];
  const coverage = claimed.length / 4;
  const cited = claimed.flatMap((p) => p.evidenceIds);
  const citedEvidence = evidence.filter((e) => cited.includes(e.id));
  const avgConf = citedEvidence.length > 0
    ? citedEvidence.reduce((s, e) => s + e.confidence, 0) / citedEvidence.length
    : evidence.reduce((s, e) => s + e.confidence, 0) / evidence.length;
  const quality = claimed.length > 0
    ? claimed.reduce((s, p) => s + (p.availability === 'AVAILABLE' ? 1 : p.availability === 'PARTIAL' ? 0.7 : 0.4), 0) / claimed.length
    : 0;
  const score = coverage * 40 + avgConf * 40 + quality * 20;
  reasons.push({
    dimension: 'confidence',
    code: 'DATA_CONFIDENCE',
    message: `Field coverage ${(coverage * 100).toFixed(0)}%, avg evidence confidence ${(avgConf * 100).toFixed(0)}%`,
    delta: clamp100(score),
    evidenceIds: cited.length > 0 ? cited : evidence.slice(0, 3).map((e) => e.id),
  });
  return clamp100(score);
}
