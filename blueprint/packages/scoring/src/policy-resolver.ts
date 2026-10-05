/**
 * Pure scoring-policy resolution and aggregation (ADR-021).
 *
 * No IO here: the caller loads scoring_policy_versions rows and hands them to
 * `resolvePolicy`. Deterministic, fully unit-testable.
 */

import type {
  PolicyThresholds,
  PolicyWeights,
  ResolvedScoringPolicy,
  ScoreResult,
  ScoreReviewOutcome,
} from './contracts.js';
import type { ScoreDimensionInput } from './contracts.js';

export interface ScoringPolicyVersionRow {
  id: string;
  policyId: string;
  version: number;
  weights: PolicyWeights;
  thresholds: PolicyThresholds;
  status: 'ACTIVE' | 'RETIRED';
  effectiveFrom: string; // ISO
  effectiveTo: string | null;
}

/** Picks the ACTIVE version effective at `at` (latest effectiveFrom wins). */
export function resolvePolicy(
  versions: ScoringPolicyVersionRow[],
  at: Date = new Date(),
): ResolvedScoringPolicy | null {
  const candidates = versions
    .filter((v) => v.status === 'ACTIVE')
    .filter((v) => new Date(v.effectiveFrom) <= at)
    .filter((v) => v.effectiveTo === null || new Date(v.effectiveTo) >= at)
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  const chosen = candidates[0];
  if (!chosen) return null;
  return {
    policyId: chosen.policyId,
    versionId: chosen.id,
    version: chosen.version,
    weights: chosen.weights,
    thresholds: chosen.thresholds,
  };
}

const DIMENSIONS: readonly (keyof PolicyWeights)[] = [
  'relevance',
  'audienceQuality',
  'activity',
  'confidence',
];

/** Validates weight semantics: each in [0,1] and sum ≈ 1. */
export function validateWeights(weights: PolicyWeights): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let sum = 0;
  for (const d of DIMENSIONS) {
    const w = weights[d];
    if (!Number.isFinite(w) || w < 0 || w > 1) errors.push(`weight ${d} out of [0,1]: ${w}`);
    sum += w;
  }
  if (Math.abs(sum - 1) > 1e-6) errors.push(`weights must sum to 1 (got ${sum})`);
  return { ok: errors.length === 0, errors };
}

function clamp100(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Weighted priority over the four independent dimensions. */
export function computePriority(
  dimensions: ScoreDimensionInput,
  weights: PolicyWeights,
): number {
  const weighted =
    dimensions.relevance * weights.relevance +
    dimensions.audienceQuality * weights.audienceQuality +
    dimensions.activity * weights.activity +
    dimensions.confidence * weights.confidence;
  return Math.round(clamp100(weighted) * 100) / 100;
}

/** Threshold mapping (policy-owned, not AI-owned). */
export function mapReviewOutcome(
  priority: number,
  thresholds: PolicyThresholds,
): ScoreReviewOutcome {
  if (priority >= thresholds.qualifiedMin) return 'QUALIFIED';
  if (priority >= thresholds.reviewMin) return 'REVIEW_REQUIRED';
  if (priority <= thresholds.rejectMax) return 'REJECTED';
  return 'REVIEW_REQUIRED'; // 40 < p < 60 default band → review, never silent
}

export function score(
  dimensions: ScoreDimensionInput,
  policy: ResolvedScoringPolicy,
  policyVersionLabel: string,
): ScoreResult {
  const priority = computePriority(dimensions, policy.weights);
  return {
    relevance: clamp100(dimensions.relevance),
    audienceQuality: clamp100(dimensions.audienceQuality),
    activity: clamp100(dimensions.activity),
    confidence: clamp100(dimensions.confidence),
    priority,
    scoringPolicyVersion: policyVersionLabel,
    reviewOutcome: mapReviewOutcome(priority, policy.thresholds),
  };
}
