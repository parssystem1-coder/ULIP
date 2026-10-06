/**
 * Error taxonomy classifier (Phase 17 §5).
 *
 * Every failed/mismatched case gets a structured category — never a generic
 * "AI error". The classifier is rule-based and deterministic, ordered from
 * mechanical causes (no data, normalization) to semantic ones (model
 * misunderstanding, grounding) so the same failure always lands in the same
 * bucket. THRESHOLD_ERROR / SCORING_ERROR apply to review-outcome misses;
 * HUMAN_LABEL_DISAGREEMENT is reserved for explicitly flagged disagreements.
 */

import type {
  EvalCase,
  EvalCaseResult,
  EvalErrorCategory,
} from './contracts.ts';
import { expectedLabelsFor } from './dataset.ts';

function hasValue(c: EvalCase): boolean {
  return (
    c.input.bio !== undefined ||
    (c.input.posts !== undefined && c.input.posts.length > 0) ||
    (c.input.categories !== undefined && c.input.categories.length > 0) ||
    c.input.website !== undefined ||
    c.input.username !== undefined
  );
}

/**
 * Attributes one failed case to exactly one error category (null when the
 * case did not fail). Priority order is fixed and documented above.
 */
export function classifyError(caseItem: EvalCase, result: EvalCaseResult): EvalErrorCategory | null {
  const failedDimensions = result.outcomes.filter(
    (o) => o.expected.length > 0 && !o.correct,
  );
  const outcomeFailed = result.reviewOutcome.expected !== null && !result.reviewOutcome.correct;
  const labelsFailed = failedDimensions.length > 0;
  const overClaims = result.outcomes.filter(
    (o) => o.expected.length === 0 && o.actual.length > 0,
  );

  if (!labelsFailed && !outcomeFailed && overClaims.length === 0) return null;

  // 1) No observable source data at all → the model could never know.
  if (!hasValue(caseItem)) return 'SOURCE_DATA_MISSING';

  // 2) Dimension absent from expected labels but asserted by the arm →
  //    over-claim on data the human did not label (normalization family).
  if (failedDimensions.length === 0 && overClaims.length > 0) return 'NORMALIZATION_ERROR';

  // 3) TAXONOMY_MISMATCH is applied by the runner via
  //    refineWithTaxonomyContext, which owns the dataset context.

  // 4) Abstention on a labeled dimension with data present → grounding gap:
  //    the evidence existed but the arm refused/failed to claim.
  const abstainedWithData = failedDimensions.filter(
    (o) => o.actual.length === 0 && o.abstained && hasValue(caseItem),
  );
  if (abstainedWithData.length > 0 && !labelsFailedButWrongValue(caseItem, result)) {
    return 'GROUNDING_FAILURE';
  }

  // 5) Review outcome missed while labels were fine → scoring/threshold cause.
  if (!labelsFailed && outcomeFailed) {
    return result.reviewOutcome.actual === null ? 'SCORING_ERROR' : 'THRESHOLD_ERROR';
  }
  if (outcomeFailed) {
    // Both label and outcome failed — the dominant cause is the label miss.
    return 'MODEL_MISUNDERSTANDING';
  }

  // 6) Default semantic failure.
  return 'MODEL_MISUNDERSTANDING';
}

function labelsFailedButWrongValue(caseItem: EvalCase, result: EvalCaseResult): boolean {
  return result.outcomes.some(
    (o) => o.expected.length > 0 && o.actual.length > 0 && !o.correct,
  );
}

/**
 * Runner-side refinement: when a wrong answer references a value that is not
 * canonical for its dimension, upgrade the category to TAXONOMY_MISMATCH.
 * Exported for the runner, which owns the dataset context.
 */
export function refineWithTaxonomyContext(
  base: EvalErrorCategory | null,
  caseItem: EvalCase,
  result: EvalCaseResult,
  isCanonical: (dimension: string, value: string) => boolean,
): EvalErrorCategory | null {
  if (base === null) return null;
  const wrongValues = result.outcomes
    .filter((o) => o.expected.length > 0 && !o.correct)
    .flatMap((o) => o.actual.map((v) => ({ dimension: o.dimension as string, value: v })))
    .filter(({ dimension, value }) => !isCanonical(dimension, value));
  if (wrongValues.length > 0) return 'TAXONOMY_MISMATCH';
  return base;
}

/** Human-readable structured detail (never chain-of-thought). */
export function errorDetail(caseItem: EvalCase, result: EvalCaseResult): string | null {
  if (result.errorCategory === null) return null;
  const failed = result.outcomes
    .filter((o) => o.expected.length > 0 && !o.correct)
    .map((o) => `${o.dimension}: expected [${o.expected.join('|')}] got [${o.actual.join('|') || '∅'}]`);
  if (result.reviewOutcome.expected !== null && !result.reviewOutcome.correct) {
    failed.push(`outcome: expected ${result.reviewOutcome.expected} got ${result.reviewOutcome.actual ?? '∅'}`);
  }
  return failed.join('; ') || 'case failed without a specific dimension';
}

/** True when any dimension of the case failed (used for run summaries). */
export function anyDimensionFailed(result: EvalCaseResult): boolean {
  return result.outcomes.some((o) => o.expected.length > 0 && !o.correct);
}

export { expectedLabelsFor };
