/**
 * Scoring package contracts.
 * Relevance, Audience Quality, Activity and Confidence are INDEPENDENT scores;
 * priority is a policy-weighted aggregate. All weights/thresholds come from a
 * persisted, versioned policy (scoring_policy_versions in schema.sql) — never
 * from code constants and never from AI output.
 */

import type { LeadAnalysisRef, LeadScoresContract, BusinessContract } from '@ulip/domain/contracts';

export interface ScoreDimensionInput {
  /** 0..100 per dimension before weighting. */
  relevance: number;
  audienceQuality: number;
  activity: number;
  confidence: number;
}

export interface PolicyWeights {
  relevance: number;
  audienceQuality: number;
  activity: number;
  confidence: number;
}

export interface PolicyThresholds {
  qualifiedMin: number; // 0..100
  reviewMin: number; // 0..100
  rejectMax: number; // 0..100
}

/** Resolved policy version — loaded from scoring_policy_versions, not invented. */
export interface ResolvedScoringPolicy {
  policyId: string;
  versionId: string;
  version: number;
  weights: PolicyWeights;
  thresholds: PolicyThresholds;
}

export interface ScoringInput {
  business: BusinessContract;
  analysis: LeadAnalysisRef;
  dimensions: ScoreDimensionInput;
}

export type ScoreReviewOutcome = 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED';

export interface ScoreResult extends LeadScoresContract {
  /** Threshold mapping per the resolved policy (ADR-021). */
  reviewOutcome: ScoreReviewOutcome;
}

export interface ScoringEngine {
  calculate(input: ScoringInput, policy: ResolvedScoringPolicy): Promise<ScoreResult>;
}

/** Loads the policy effective for a tenant at a point in time. */
export interface ScoringPolicyResolver {
  resolve(input: { tenantId: string; at?: string }): Promise<ResolvedScoringPolicy>;
}
