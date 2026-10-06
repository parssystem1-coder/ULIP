/**
 * Evaluation contracts (Phase 17, ADR-029).
 *
 * Typed, versioned shapes for the human-labeled dataset, per-case and per-run
 * results, metric blocks, the error taxonomy and the regression comparison.
 * No `unknown` in public contracts (ADR-023).
 *
 * Nothing here duplicates an existing AI contract: the classifier under test
 * is still `@ulip/ai`'s `LLMProvider` / `StructuredProfile`, and scoring is
 * still `@ulip/scoring`'s `score()`. These types describe measurement only.
 */

import type { TaxonomyOption } from '@ulip/ai';
import type { TaxonomyNodeKind } from '@ulip/domain/contracts';

// ---------------------------------------------------------------------------
// Error taxonomy (§5) — every failure is attributed, never lumped into "AI error"
// ---------------------------------------------------------------------------

export type EvalErrorCategory =
  | 'SOURCE_DATA_MISSING'
  | 'NORMALIZATION_ERROR'
  | 'TAXONOMY_MISMATCH'
  | 'MODEL_MISUNDERSTANDING'
  | 'GROUNDING_FAILURE'
  | 'THRESHOLD_ERROR'
  | 'SCORING_ERROR'
  | 'HUMAN_LABEL_DISAGREEMENT'
  | 'OTHER';

export const EVAL_ERROR_CATEGORIES: readonly EvalErrorCategory[] = [
  'SOURCE_DATA_MISSING',
  'NORMALIZATION_ERROR',
  'TAXONOMY_MISMATCH',
  'MODEL_MISUNDERSTANDING',
  'GROUNDING_FAILURE',
  'THRESHOLD_ERROR',
  'SCORING_ERROR',
  'HUMAN_LABEL_DISAGREEMENT',
  'OTHER',
];

// ---------------------------------------------------------------------------
// Evaluated dimensions (§4) — the universal business model + location
// ---------------------------------------------------------------------------

export type EvalDimension =
  | 'businessType'
  | 'industry'
  | 'specialty'
  | 'subSpecialty'
  | 'brand'
  | 'location';

export const EVAL_DIMENSIONS: readonly EvalDimension[] = [
  'businessType',
  'industry',
  'specialty',
  'subSpecialty',
  'brand',
  'location',
];

/** Case tags used for per-category regression reporting (§11). */
export type EvalCaseTag =
  | 'BUSINESS_TYPE' // one of the canonical business types
  | 'INDUSTRY'
  | 'SPECIALTY'
  | 'SUB_SPECIALTY'
  | 'BRAND'
  | 'LOCATION'
  | 'PERSIAN'
  | 'ENGLISH'
  | 'MIXED'
  | 'ARABIC_VARIANTS'
  | 'ZWNJ'
  | 'AMBIGUOUS'
  | 'WEAK_EVIDENCE'
  | 'STRONG_EVIDENCE'
  | 'MISSING_LOCATION'
  | 'INACTIVE'
  | 'NOISY_AUDIENCE'
  | 'CANONICAL';

// ---------------------------------------------------------------------------
// Dataset (§2) — human-labeled, versioned, stored in the repository
// ---------------------------------------------------------------------------

/**
 * One human-labeled case. `expected` is ALWAYS written by a human reviewer;
 * the loader rejects a dataset whose provenance does not say so.
 *
 * `input` holds the OBSERVABLE FACTS about the business — the same shape the
 * analysis runtime consumes — so the evaluation exercises the real
 * evidence → extraction → scoring path instead of a private shortcut.
 */
export interface EvalCase {
  /** Stable id, unique inside a dataset version (e.g. "ev-001"). */
  caseId: string;
  /** Free-text human description of the case (never shown to the provider). */
  description: string;
  tags: EvalCaseTag[];
  /** UI/content locale of the case. */
  locale: 'fa' | 'en';
  input: EvalCaseInput;
  /** Human labels for the universal business model. */
  expected: EvalExpectedLabels;
  /** Human review outcome label for scoring evaluation (§9). Optional. */
  expectedOutcome?: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED';
}

/** Observable facts. Every field is optional — absence is honest, not invented. */
export interface EvalCaseInput {
  name: string;
  /** Business description / bio. */
  bio?: string;
  categories?: string[];
  city?: string;
  country?: string;
  website?: string;
  /** Contact channel KINDS present (values are never evaluated or stored). */
  contactChannels?: string[];
  /** Source identity (when the case represents a social profile). */
  username?: string;
  displayName?: string;
  externalId?: string;
  sourceType?: string;
  posts?: { text: string; daysAgo?: number }[];
  followers?: number;
  postsCount?: number;
}

/** Human labels for the universal business model. */
export interface EvalExpectedLabels {
  businessType: string | null;
  industry: string | null;
  specialty: string[];
  subSpecialty: string[];
  brand: string[];
  location: string | null;
}

/** Label→aliases mapping used by the deterministic RULES_ONLY arm (§6). */
export interface EvalTaxonomyAlias {
  /**
   * Canonical label: a node label from `taxonomySnapshot`, or — when `kind`
   * is 'BRAND' — a canonical free-text brand (no BRAND node kind exists).
   */
  label: string;
  aliases: string[];
  /** Required for labels that are NOT in the snapshot (brands). */
  kind?: TaxonomyNodeKind | 'BRAND';
}

/** City alias mapping used by the deterministic RULES_ONLY arm. */
export interface EvalLocationAlias {
  alias: string;
  city: string;
}

export interface EvalDataset {
  /** Semver-ish dataset version, e.g. "1.0.0". */
  datasetVersion: string;
  /** Provenance statement — the loader requires it to declare human labels. */
  provenance: string;
  /** Frozen taxonomy snapshot the labels were written against. */
  taxonomySnapshot: TaxonomyOption[];
  /** Version id of the frozen snapshot (recorded on every case result). */
  taxonomyVersion: number;
  taxonomyAliases: EvalTaxonomyAlias[];
  locationAliases: EvalLocationAlias[];
  cases: EvalCase[];
}

// ---------------------------------------------------------------------------
// Execution (§6 arms, §7 providers)
// ---------------------------------------------------------------------------

export type EvalArmId =
  | 'RULES_ONLY'
  | 'LLM_ONLY'
  | 'RULES_THEN_LLM'
  | 'LLM_THEN_DECISION_PROVIDER'
  | 'RULES_LLM_DECISION_PROVIDER'
  | 'PROFILE_ONLY'
  | 'TEXT_CONTENT'
  | 'TEXT_IMAGE'
  | 'FULL_AVAILABLE_EVIDENCE';

export const EVAL_ARM_IDS: readonly EvalArmId[] = [
  'RULES_ONLY',
  'LLM_ONLY',
  'RULES_THEN_LLM',
  'LLM_THEN_DECISION_PROVIDER',
  'RULES_LLM_DECISION_PROVIDER',
  // Phase 18 content/multimodal comparison arms (attack the same labels with
  // progressively more of the evidence the production flow would have).
  'PROFILE_ONLY',
  'TEXT_CONTENT',
  'TEXT_IMAGE',
  'FULL_AVAILABLE_EVIDENCE',
];

/** An arm runs only when its providers are configured; otherwise recorded. */
export type EvalArmStatus = 'EXECUTED' | 'NOT_CONFIGURED' | 'FAILED';

export interface EvalArmAvailability {
  arm: EvalArmId;
  status: EvalArmStatus;
  /** Why the arm was not executed (e.g. no DecisionProvider → Jev unplugged). */
  reason?: string;
}

/** Version metadata stamped on every case result (§3). */
export interface EvalVersions {
  datasetVersion: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  taxonomyVersion: number;
  scoringPolicyVersion: string;
}

// ---------------------------------------------------------------------------
// Per-case result (§3)
// ---------------------------------------------------------------------------

export interface EvalLabelOutcome {
  dimension: EvalDimension;
  expected: string[];
  actual: string[];
  correct: boolean;
  /** Null when the arm abstained / the field was unavailable. */
  confidence: number | null;
  /** True when the arm produced no answer for a dimension the human labeled. */
  abstained: boolean;
}

export interface EvalCaseResult {
  caseId: string;
  arm: EvalArmId;
  versions: EvalVersions;
  /** Per-dimension comparison, always all six dimensions. */
  outcomes: EvalLabelOutcome[];
  /** Overall exact match across all six dimensions. */
  exactMatch: boolean;
  /** Share of labeled dimensions answered correctly (0..1). */
  dimensionAccuracy: number;
  /** Mean model confidence over answered dimensions (null if none answered). */
  meanConfidence: number | null;
  /** True when the model's confidence disagrees with its own correctness. */
  miscalibrated: boolean;
  reviewOutcome: {
    expected: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED' | null;
    actual: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED' | null;
    correct: boolean;
  };
  /** Score dimensions produced for this case (0..100). */
  scores: {
    relevance: number;
    audienceQuality: number;
    activity: number;
    confidence: number;
    priority: number;
  };
  latencyMs: number;
  /** Present only when the provider returned usage metadata. */
  tokens: { input: number; output: number } | null;
  estimatedCost: number | null;
  errorCategory: EvalErrorCategory | null;
  /** Structured, human-readable reason — never chain-of-thought. */
  errorDetail: string | null;
}

// ---------------------------------------------------------------------------
// Metrics (§4)
// ---------------------------------------------------------------------------

export interface ClassificationMetrics {
  /** Number of evaluated cases for this dimension. */
  support: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  /** Confusion matrix over the sorted union of expected+actual labels. */
  confusionMatrix: { labels: string[]; matrix: number[][] };
  /** Cases where the arm answered nothing for a human-labeled dimension. */
  abstentions: number;
  /** Share of labeled cases answered at all (0..1). */
  coverage: number;
}

export interface CalibrationBucket {
  /** Inclusive lower bound of the bucket, e.g. 0.7 for [0.7, 0.8). */
  lower: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  /** Expected calibration error (weighted mean |accuracy - confidence|). */
  expectedCalibrationError: number;
  /** mean(confidence) - accuracy; positive = over-confident. */
  overConfidence: number;
  /** Share of answered predictions that were wrong. */
  errorRate: number;
  answered: number;
}

export interface LatencyReport {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
}

export interface CostReport {
  /** Null when no provider returned token/cost metadata (§4). */
  costPerCase: number | null;
  totalCost: number | null;
  casesWithCost: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface ErrorTaxonomyReport {
  counts: Record<EvalErrorCategory, number>;
  total: number;
}

// ---------------------------------------------------------------------------
// Score evaluation (§9)
// ---------------------------------------------------------------------------

export interface ScoreDimensionDiagnostic {
  dimension: 'relevance' | 'audienceQuality' | 'activity' | 'confidence' | 'priority';
  mean: number;
  min: number;
  max: number;
  /** Share of cases at exactly 0 — a "missing data" smell. */
  zeroShare: number;
  /** Share of cases at the 0/100 extremes. */
  extremeShare: number;
  /** Pearson correlation with each other dimension (0 when undefined). */
  correlation: Record<string, number>;
  /** Highest |correlation| with another dimension. */
  maxCorrelation: number;
}

export interface ScoreEvaluationReport {
  dimensions: ScoreDimensionDiagnostic[];
  /** Separation: mean priority of human-QUALIFIED vs human-REJECTED cases. */
  separation: {
    qualifiedMeanPriority: number | null;
    rejectedMeanPriority: number | null;
    /** qualifiedMean - rejectedMean; null when a side has no cases. */
    gap: number | null;
    separates: boolean;
  };
  /** Correlation of each dimension with the human outcome label (0 when undefined). */
  outcomeCorrelation: Record<string, number>;
  /** True when a dimension's variance is dominated by zero/missing values. */
  dominatedByMissingData: string[];
}

// ---------------------------------------------------------------------------
// Run + regression (§10, §11)
// ---------------------------------------------------------------------------

export interface EvalRunMetrics {
  /** Cases evaluated (0 when the arm was not executed). */
  totalCases: number;
  overall: ClassificationMetrics;
  byDimension: Record<EvalDimension, ClassificationMetrics>;
  /** Macro average over the six per-dimension F1 scores. */
  macroF1: number;
  calibration: CalibrationReport;
  latency: LatencyReport;
  cost: CostReport;
  errors: ErrorTaxonomyReport;
  /** Share of labeled (case, dimension) pairs the arm abstained on (0..1). */
  abstentionRate: number;
  /** 1 - abstentionRate: share of labeled pairs answered (0..1). */
  coverage: number;
  /** Share of case-level review outcomes matching the human label. */
  outcomeAccuracy: number;
  /** Per-tag metrics — the granularity per-category regressions are read at. */
  byTag: Record<string, { support: number; accuracy: number; f1: number }>;
  scoreEvaluation: ScoreEvaluationReport;
}

export interface EvalRunRecord {
  /** Deterministic id: hash(datasetVersion, arm, provider, model, prompt). */
  runId: string;
  tenantId: string;
  versions: EvalVersions;
  arm: EvalArmId;
  armStatus: EvalArmStatus;
  armReason: string | null;
  startedAt: string;
  finishedAt: string;
  metrics: EvalRunMetrics;
}

/** A metric that got worse relative to the baseline (§11). */
export interface RegressionFinding {
  /** Dotted path into the metrics object, e.g. "byDimension.specialty.f1". */
  metric: string;
  /** Human-readable category label (dimension or tag the metric belongs to). */
  category: string;
  baseline: number;
  current: number;
  delta: number;
  /** Absolute degradation beyond this threshold counts as a regression. */
  threshold: number;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
}

export interface RegressionReport {
  baselineRunId: string;
  currentRunId: string;
  datasetVersion: string;
  /** True when baseline and current used different dataset versions. */
  datasetVersionChanged: boolean;
  findings: RegressionFinding[];
  improved: { metric: string; delta: number }[];
  /** Release gate: true when CRITICAL or MAJOR regressions exist (§11). */
  hasRegressions: boolean;
}
