/**
 * AI package contracts — typed; no `unknown` in any public interface (ADR-023).
 *
 * Jev / DecisionProvider is an OPTIONAL capability selected by tenant policy
 * (ADR-018). The platform must operate with any strategy in DecisionStrategy.
 */

import type {
  AnalysisMode,
  Availability,
  LeadSearchFilters,
  TaxonomyNodeKind,
} from '@ulip/domain/contracts';

// ---------------------------------------------------------------------------
// Shared AI metadata
// ---------------------------------------------------------------------------

export type AiTaskType =
  | 'CLASSIFICATION'
  | 'EXTRACTION'
  | 'QUERY_PARSING'
  | 'SUMMARIZATION'
  | 'EVIDENCE_EXTRACTION'
  | 'VISUAL_ANALYSIS'
  | 'DECISION_MAKING';

export interface AiMetadata {
  provider: string;
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

// ---------------------------------------------------------------------------
// Structured profile extraction (mirrors docs/ai/TASK-CONTRACTS.md)
// ---------------------------------------------------------------------------

export interface ContentSample {
  contentId: string;
  text?: string;
  mediaUri?: string;
  publishedAt?: string;
}

export interface TaxonomyOption {
  nodeId: string;
  label: string;
  nodeKind: TaxonomyNodeKind;
}

export interface ProfileExtractionInput {
  profileText?: string;
  locationHints?: string[];
  contentSamples: ContentSample[];
  taxonomySnapshot: TaxonomyOption[];
  /** UI/content locale, e.g. 'fa' — Persian content is first-class. */
  locale?: string;
}

export interface FieldPrediction {
  /** Taxonomy node id, or free text when no canonical node exists. */
  value: string;
  confidence: number; // 0..1
  evidenceIds: string[];
  availability: Availability;
}

export interface CityPrediction extends FieldPrediction {
  provenance: 'EXPLICIT' | 'INFERRED' | 'UNKNOWN';
}

export interface StructuredProfile {
  businessType?: FieldPrediction;
  industry?: FieldPrediction;
  specialties: FieldPrediction[];
  brands?: FieldPrediction[];
  city?: CityPrediction;
}

export interface ExtractionResult {
  profile: StructuredProfile;
  meta: AiMetadata;
}

// ---------------------------------------------------------------------------
// LLM provider
// ---------------------------------------------------------------------------

export interface ParsedSearchQuery {
  /** Typed query object. An LLM must never generate SQL or filter expressions. */
  filters: LeadSearchFilters;
  confidence: number; // 0..1
  unmatchedTerms: string[];
  meta: AiMetadata;
}

export interface LLMProvider {
  extractStructuredProfile(input: ProfileExtractionInput): Promise<ExtractionResult>;
  parseSearchQuery(input: { text: string; locale: string }): Promise<ParsedSearchQuery>;
  summarize(input: { text: string; maxPoints: number }): Promise<{
    summary: string;
    meta: AiMetadata;
  }>;
}

// ---------------------------------------------------------------------------
// Vision provider
// ---------------------------------------------------------------------------

export interface VisualObservation {
  label: string;
  confidence: number; // 0..1
  evidenceIds: string[];
}

export interface VisualAnalysis {
  observations: VisualObservation[];
  meta: AiMetadata;
}

export interface VisionProvider {
  analyzeImage(input: { uri: string; context?: string }): Promise<VisualAnalysis>;
  analyzeImages(input: { uris: string[]; context?: string }): Promise<VisualAnalysis[]>;
}

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(input: { text: string }): Promise<{ vector: number[]; meta: AiMetadata }>;
}

// ===========================================================================
// Decision provider ("Jev") — optional, bounded, never owns workflow.
// ===========================================================================

export type DecisionTaskType = 'CLASSIFICATION' | 'ROUTING' | 'AMBIGUITY_RESOLUTION';

export interface DecisionOption {
  /** Stable id (taxonomy node id / slug) — never positional keys like "A"/"B". */
  id: string;
  label: string;
}

export interface DecisionFact {
  kind: string;
  value: string;
  confidence?: number;
  evidenceIds?: string[];
}

export interface DecisionContext {
  leadId?: string;
  taskType: DecisionTaskType;
  taxonomyVersion?: number;
  facts: DecisionFact[];
}

export interface DecisionRequest {
  question: string;
  options: DecisionOption[];
  context: DecisionContext;
}

export interface DecisionProbability {
  optionId: string;
  /** 0..1, finite. See validateDecisionResponse for the full contract. */
  probability: number;
}

export interface DecisionResponse {
  probabilities: DecisionProbability[];
  selectedOptionId?: string;
  provider: string;
  modelVersion: string;
}

export interface DecisionProvider {
  readonly name: string;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
  healthCheck(): Promise<{ ok: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Probability contract (enforced by the AI gateway, not trusted from provider)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Probability contract:
 *  - every probability is a finite number in [0, 1];
 *  - every option id from the request appears exactly once (no missing,
 *    no duplicate, no unknown ids);
 *  - probabilities sum to 1 within 1e-6 (gateway normalizes minor drift);
 *  - `selectedOptionId` (if present) must be one of the option ids.
 * Invalid output is a SCHEMA_VALIDATION_ERROR → bounded repair/retry or
 * fallback per the decision policy. The application owns thresholds.
 */
export function validateDecisionResponse(
  request: DecisionRequest,
  response: DecisionResponse,
): ValidationResult {
  const errors: string[] = [];
  const optionIds = new Set(request.options.map((o) => o.id));
  const seen = new Set<string>();
  let sum = 0;

  for (const p of response.probabilities) {
    if (!optionIds.has(p.optionId)) {
      errors.push(`unknown optionId: ${p.optionId}`);
      continue;
    }
    if (seen.has(p.optionId)) {
      errors.push(`duplicate optionId: ${p.optionId}`);
      continue;
    }
    seen.add(p.optionId);
    if (!Number.isFinite(p.probability) || p.probability < 0 || p.probability > 1) {
      errors.push(`probability out of range for ${p.optionId}: ${p.probability}`);
      continue;
    }
    sum += p.probability;
  }

  for (const id of optionIds) {
    if (!seen.has(id)) errors.push(`missing probability for option: ${id}`);
  }
  if (errors.length === 0 && Math.abs(sum - 1) > 1e-6) {
    errors.push(`probabilities must sum to 1 (got ${sum})`);
  }
  if (response.selectedOptionId !== undefined && !optionIds.has(response.selectedOptionId)) {
    errors.push(`selectedOptionId is not a request option: ${response.selectedOptionId}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Decision strategy — Jev is optional by construction
// ---------------------------------------------------------------------------

/**
 * Execution strategies for bounded decisions. Tenant policy selects one
 * (decision_policy_versions.decision_strategy in schema.sql). 'RULES_ONLY'
 * and 'LLM_ONLY' must fully function without any DecisionProvider configured.
 */
export type DecisionStrategy =
  | 'RULES_ONLY'
  | 'LLM_ONLY'
  | 'DECISION_PROVIDER_ONLY'
  | 'LLM_THEN_DECISION_PROVIDER'
  | 'RULES_THEN_LLM'
  | 'RULES_LLM_DECISION_PROVIDER';

export interface DecisionThresholds {
  accept: number; // >= review
  review: number; // >= reject
  reject: number;
  fallback: number;
}

export type DecisionOutcomeStatus = 'ACCEPTED' | 'REVIEW_REQUIRED' | 'REJECTED' | 'ABSTAINED';

export interface DecisionOutcome {
  response: DecisionResponse;
  status: DecisionOutcomeStatus;
  appliedThreshold: number;
  strategy: DecisionStrategy;
}

/** Selects the winning option from a validated response using policy thresholds. */
export interface DecisionPolicyEvaluator {
  evaluate(
    request: DecisionRequest,
    strategy: DecisionStrategy,
    thresholds: DecisionThresholds,
  ): Promise<DecisionOutcome>;
}
