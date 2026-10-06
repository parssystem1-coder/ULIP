/**
 * Evaluation metrics (Phase 17 §4, §8, §9).
 *
 * Semantics (documented, deterministic):
 *  - The unit of evaluation is a (case, dimension) pair whose EXPECTED labels
 *    are non-empty. Pairs where the human labeled nothing are not measured —
 *    over-claims on unlabeled dimensions stay visible per-case (they falsify
 *    exactMatch) but never inflate the aggregates.
 *  - correctness = aliasKey set-equality between expected and actual labels
 *    (normalization via @ulip/domain, so ZWNJ / Arabic variants compare equal).
 *  - precision/recall/F1 are MICRO-averaged over per-pair binary hits; the
 *    confusion matrix accumulates one (expected, actual) vote per pair.
 *  - confidence, latency and cost are means over the cases that produced them.
 *  - calibration uses answered pairs with non-null confidence, bucketed in
 *    [0.5,0.6)…[0.9,1.0] — predictions below 0.5 mean "effectively abstained".
 */

import { aliasKey } from '@ulip/domain';
import type {
  CalibrationBucket,
  CalibrationReport,
  ClassificationMetrics,
  CostReport,
  ErrorTaxonomyReport,
  EvalCaseResult,
  EvalDimension,
  EvalErrorCategory,
  EvalLabelOutcome,
  EvalRunMetrics,
  LatencyReport,
  ScoreDimensionDiagnostic,
  ScoreEvaluationReport,
} from './contracts.ts';
import { EVAL_DIMENSIONS, EVAL_ERROR_CATEGORIES } from './contracts.ts';

export const CALIBRATION_BUCKET_LOWER_BOUNDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function labelsMatch(expected: readonly string[], actual: readonly string[]): boolean {
  const e = [...expected].map(aliasKey).sort();
  const a = [...actual].map(aliasKey).sort();
  if (e.length !== a.length) return false;
  return e.every((v, i) => v === a[i]);
}

function oneHot(labels: readonly string[], all: readonly string[]): number[] {
  return all.map((l) => (labels.includes(l) ? 1 : 0));
}

/** Exact set-match accuracy over every labeled pair (human-labeled only). */
function accuracyOf(pairs: readonly { expected: string[]; actual: string[] }[]): number {
  if (pairs.length === 0) return 0;
  const hits = pairs.filter((p) => labelsMatch(p.expected, p.actual)).length;
  return r4(hits / pairs.length);
}

/** Micro-averaged one-vs-rest precision/recall/F1 over the labeled pairs. */
function prfOf(pairs: readonly { expected: string[]; actual: string[] }[]): {
  precision: number;
  recall: number;
  f1: number;
} {
  if (pairs.length === 0) return { precision: 0, recall: 0, f1: 0 };
  const labelSet = new Set<string>();
  for (const p of pairs) {
    for (const l of p.expected) labelSet.add(aliasKey(l));
    for (const l of p.actual) labelSet.add(aliasKey(l));
  }
  const all = [...labelSet].sort();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const p of pairs) {
    const e = oneHot(p.expected.map(aliasKey), all);
    const a = oneHot(p.actual.map(aliasKey), all);
    for (let i = 0; i < all.length; i++) {
      if (e[i] === 1 && a[i] === 1) tp += 1;
      else if (e[i] === 0 && a[i] === 1) fp += 1;
      else if (e[i] === 1 && a[i] === 0) fn += 1;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision: r4(precision), recall: r4(recall), f1: r4(f1) };
}

export function classificationMetrics(
  pairs: readonly { expected: string[]; actual: string[] }[],
  abstentions: number,
  confidenceById: ReadonlyMap<string, number | null>,
): ClassificationMetrics {
  const labelSet = new Set<string>();
  for (const p of pairs) {
    for (const l of p.expected) labelSet.add(aliasKey(l));
    for (const l of p.actual) labelSet.add(aliasKey(l));
  }
  const labels = [...labelSet].sort();
  const matrix = labels.map(() => labels.map(() => 0));
  for (const p of pairs) {
    const e = p.expected.map(aliasKey).sort()[0] ?? '';
    const a = p.actual.map(aliasKey).sort()[0] ?? '';
    const ei = labels.indexOf(e);
    const ai = labels.indexOf(a);
    if (ei >= 0 && ai >= 0) matrix[ei]![ai] = (matrix[ei]![ai] ?? 0) + 1;
  }
  const answered = pairs.length;
  const support = answered + abstentions;
  const { precision, recall, f1 } = prfOf(pairs);
  return {
    support,
    accuracy: accuracyOf(pairs),
    precision,
    recall,
    f1,
    confusionMatrix: { labels, matrix },
    abstentions,
    coverage: support === 0 ? 0 : r4(answered / support),
    ...(confidenceById.size > 0 ? {} : {}),
  };
}

/** Calibration buckets over answered pairs with a confidence value. */
export function calibrationReport(pairs: readonly EvalLabelOutcome[]): CalibrationReport {
  const scored = pairs.filter(
    (p): p is EvalLabelOutcome & { confidence: number } => p.confidence !== null,
  );
  const buckets: CalibrationBucket[] = [];
  for (const lower of CALIBRATION_BUCKET_LOWER_BOUNDS) {
    const inBucket = scored.filter((p) => p.confidence >= lower && p.confidence < lower + 0.1);
    buckets.push({
      lower,
      count: inBucket.length,
      meanConfidence: r4(mean(inBucket.map((p) => p.confidence))),
      accuracy: r4(mean(inBucket.map((p) => (p.correct ? 1 : 0)))),
    });
  }
  const ece = scored.length === 0
    ? 0
    : scored.reduce((s, p) => s + Math.abs((p.correct ? 1 : 0) - p.confidence), 0) / scored.length;
  const meanConf = mean(scored.map((p) => p.confidence));
  const acc = mean(scored.map((p) => (p.correct ? 1 : 0)));
  return {
    buckets,
    expectedCalibrationError: r4(ece),
    // positive → the model claims more confidence than its accuracy earns
    overConfidence: r4(meanConf - acc),
    errorRate: scored.length === 0 ? 0 : r4(scored.filter((p) => !p.correct).length / scored.length),
    answered: scored.length,
  };
}

export function latencyReport(values: readonly number[]): LatencyReport {
  if (values.length === 0) return { p50Ms: 0, p95Ms: 0, meanMs: 0, maxMs: 0 };
  return {
    p50Ms: Math.round(percentile(values, 50)),
    p95Ms: Math.round(percentile(values, 95)),
    meanMs: Math.round(mean(values)),
    maxMs: Math.max(...values),
  };
}

export function costReport(results: readonly EvalCaseResult[]): CostReport {
  const withCost = results.filter((r) => r.estimatedCost !== null);
  const total = withCost.reduce((s, r) => s + (r.estimatedCost ?? 0), 0);
  return {
    costPerCase: withCost.length === 0 ? null : r4(total / withCost.length),
    totalCost: withCost.length === 0 ? null : r4(total),
    casesWithCost: withCost.length,
    tokensInput: results.reduce((s, r) => s + (r.tokens?.input ?? 0), 0),
    tokensOutput: results.reduce((s, r) => s + (r.tokens?.output ?? 0), 0),
  };
}

export function errorTaxonomyReport(results: readonly EvalCaseResult[]): ErrorTaxonomyReport {
  const counts = {} as Record<EvalErrorCategory, number>;
  for (const c of EVAL_ERROR_CATEGORIES) counts[c] = 0;
  for (const r of results) {
    if (r.errorCategory !== null) counts[r.errorCategory] += 1;
  }
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  return { counts, total };
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (xs[i] ?? 0) - mx;
    const b = (ys[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

const SCORE_DIMENSIONS = [
  'relevance',
  'audienceQuality',
  'activity',
  'confidence',
  'priority',
] as const;

/** Score-behavior diagnostics against human outcome labels (§9). */
export function scoreEvaluationReport(results: readonly EvalCaseResult[]): ScoreEvaluationReport {
  const labeled = results.filter((r) => r.reviewOutcome.expected !== null);
  const dims: ScoreDimensionDiagnostic[] = SCORE_DIMENSIONS.map((dim) => {
    const values = results.map((r) => r.scores[dim]);
    const correlation: Record<string, number> = {};
    let maxCorr = 0;
    for (const other of SCORE_DIMENSIONS) {
      if (other === dim) continue;
      const c = r4(Math.abs(pearson(values, results.map((r) => r.scores[other]))));
      correlation[other] = c;
      if (c > maxCorr) maxCorr = c;
    }
    return {
      dimension: dim,
      mean: r4(mean(values)),
      min: values.length === 0 ? 0 : Math.min(...values),
      max: values.length === 0 ? 0 : Math.max(...values),
      zeroShare: values.length === 0 ? 0 : r4(values.filter((v) => v === 0).length / values.length),
      extremeShare:
        values.length === 0 ? 0 : r4(values.filter((v) => v <= 5 || v >= 95).length / values.length),
      correlation,
      maxCorrelation: r4(maxCorr),
    };
  });

  const qualified = labeled.filter((r) => r.reviewOutcome.expected === 'QUALIFIED');
  const rejected = labeled.filter((r) => r.reviewOutcome.expected === 'REJECTED');
  const qualifiedMeanPriority = qualified.length === 0 ? null : r4(mean(qualified.map((r) => r.scores.priority)));
  const rejectedMeanPriority = rejected.length === 0 ? null : r4(mean(rejected.map((r) => r.scores.priority)));
  const gap = qualifiedMeanPriority === null || rejectedMeanPriority === null
    ? null
    : r4(qualifiedMeanPriority - rejectedMeanPriority);

  const outcomeCorrelation: Record<string, number> = {};
  const outcomeNumeric = labeled.map((r) => {
    if (r.reviewOutcome.expected === 'QUALIFIED') return 1;
    if (r.reviewOutcome.expected === 'REJECTED') return -1;
    return 0;
  });
  for (const dim of SCORE_DIMENSIONS) {
    outcomeCorrelation[dim] = labeled.length === 0
      ? 0
      : r4(pearson(labeled.map((r) => r.scores[dim]), outcomeNumeric));
  }

  const dominatedByMissingData = dims
    .filter((d) => d.zeroShare >= 0.3 && d.dimension !== 'priority')
    .map((d) => d.dimension);

  return {
    dimensions: dims,
    separation: {
      qualifiedMeanPriority,
      rejectedMeanPriority,
      gap,
      separates: gap !== null && gap > 10,
    },
    outcomeCorrelation,
    dominatedByMissingData,
  };
}

/** Aggregates the full run metrics from per-case results (deterministic). */
export function aggregateRunMetrics(
  results: readonly EvalCaseResult[],
  tagsByCase: ReadonlyMap<string, readonly string[]> = new Map(),
): EvalRunMetrics {
  const dimensionPairs = new Map<EvalDimension, { expected: string[]; actual: string[] }[]>();
  const dimensionAbstentions = new Map<EvalDimension, number>();
  const dimensionConfidence = new Map<EvalDimension, Map<string, number | null>>();
  const allPairs: { expected: string[]; actual: string[] }[] = [];
  let allAbstentions = 0;

  for (const dim of EVAL_DIMENSIONS) {
    dimensionPairs.set(dim, []);
    dimensionAbstentions.set(dim, 0);
    dimensionConfidence.set(dim, new Map());
  }

  for (const r of results) {
    for (const o of r.outcomes) {
      const expectedEmpty = o.expected.length === 0;
      const actualEmpty = o.actual.length === 0;
      if (expectedEmpty) continue; // unlabeled by humans → not measured
      if (actualEmpty) {
        dimensionAbstentions.set(o.dimension, (dimensionAbstentions.get(o.dimension) ?? 0) + 1);
        allAbstentions += 1;
        continue; // abstained pairs are counted, never folded into answered pairs
      }
      allPairs.push({ expected: o.expected, actual: o.actual });
      dimensionPairs.get(o.dimension)?.push({ expected: o.expected, actual: o.actual });
      dimensionConfidence.get(o.dimension)?.set(`${r.caseId}:${o.dimension}`, o.confidence);
    }
  }

  const byDimension = {} as Record<EvalDimension, ClassificationMetrics>;
  for (const dim of EVAL_DIMENSIONS) {
    byDimension[dim] = classificationMetrics(
      dimensionPairs.get(dim) ?? [],
      dimensionAbstentions.get(dim) ?? 0,
      dimensionConfidence.get(dim) ?? new Map(),
    );
  }
  const overall = classificationMetrics(
    allPairs,
    allAbstentions,
    new Map([...dimensionConfidence.values()].flatMap((m) => [...m])),
  );

  const macroF1 = r4(mean(EVAL_DIMENSIONS.map((d) => byDimension[d].f1)));

  const byTag: Record<string, { support: number; accuracy: number; f1: number }> = {};
  const tagCaseIds = new Map<string, string[]>();
  for (const [caseId, tags] of tagsByCase) {
    for (const t of tags) {
      const list = tagCaseIds.get(t) ?? [];
      list.push(caseId);
      tagCaseIds.set(t, list);
    }
  }
  for (const tag of [...tagCaseIds.keys()].sort()) {
    const caseIds = new Set(tagCaseIds.get(tag) ?? []);
    const tagResults = results.filter((r) => caseIds.has(r.caseId));
    const pairs: { expected: string[]; actual: string[] }[] = [];
    let abstained = 0;
    for (const r of tagResults) {
      for (const o of r.outcomes) {
        if (o.expected.length === 0) continue;
        if (o.actual.length === 0) abstained += 1;
        else pairs.push({ expected: o.expected, actual: o.actual });
      }
    }
    const { f1 } = prfOf(pairs);
    byTag[tag] = { support: tagResults.length, accuracy: accuracyOf(pairs), f1 };
  }

  const totalLabeledPairs = allPairs.length + allAbstentions;
  const answeredOutcomes = results.filter((r) => r.reviewOutcome.actual !== null);
  const outcomeCorrect = answeredOutcomes.filter((r) => r.reviewOutcome.correct);
  const outcomeLabeled = results.filter((r) => r.reviewOutcome.expected !== null);

  return {
    totalCases: results.length,
    overall,
    byDimension,
    macroF1,
    calibration: calibrationReport(results.flatMap((r) => r.outcomes)),
    latency: latencyReport(results.map((r) => r.latencyMs)),
    cost: costReport(results),
    errors: errorTaxonomyReport(results),
    abstentionRate: totalLabeledPairs === 0 ? 0 : r4(allAbstentions / totalLabeledPairs),
    coverage: totalLabeledPairs === 0 ? 0 : r4(allPairs.length / totalLabeledPairs),
    outcomeAccuracy:
      outcomeLabeled.length === 0
        ? 0
        : r4(
            outcomeLabeled.filter(
              (r) => r.reviewOutcome.actual !== null && r.reviewOutcome.correct,
            ).length / outcomeLabeled.length,
          ),
    byTag,
    scoreEvaluation: scoreEvaluationReport(results),
  };
}

export { labelsMatch, mean, prfOf, accuracyOf };
