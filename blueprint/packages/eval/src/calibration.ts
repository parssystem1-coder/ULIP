/**
 * Calibration analysis (Phase 17 §8).
 *
 * Thin, documented wrappers around the calibration metrics in metrics.ts so
 * callers read intent (`buildCalibrationReport`) instead of implementation.
 * No thresholds are changed here — measurement only (§8 non-goal).
 */

import type {
  CalibrationBucket,
  CalibrationReport,
  EvalLabelOutcome,
} from './contracts.ts';
import { CALIBRATION_BUCKET_LOWER_BOUNDS } from './metrics.ts';

const CONFIDENCE_BUCKETS = CALIBRATION_BUCKET_LOWER_BOUNDS;

export { CALIBRATION_BUCKET_LOWER_BOUNDS as CONFIDENCE_BUCKETS };

/**
 * Builds the calibration report from answered predictions. Re-uses the exact
 * bucketing used inside run aggregation, so standalone calibration analysis
 * always matches the run report numbers.
 */
export function buildCalibrationReport(outcomes: readonly EvalLabelOutcome[]): CalibrationReport {
  const scored = outcomes.filter((o) => o.expected.length > 0 && o.actual.length > 0);
  // calibrationReport in metrics.ts operates on EvalLabelOutcome[] and already
  // filters null confidences internally.
  return calibrationFromMetrics(scored);
}

function calibrationFromMetrics(pairs: readonly EvalLabelOutcome[]): CalibrationReport {
  const buckets: CalibrationBucket[] = [];
  const scored = pairs.filter(
    (p): p is EvalLabelOutcome & { confidence: number } => p.confidence !== null,
  );
  for (const lower of CONFIDENCE_BUCKETS) {
    const inBucket = scored.filter((p) => p.confidence >= lower && p.confidence < lower + 0.1);
    const mc = inBucket.length === 0 ? 0 : inBucket.reduce((s, p) => s + p.confidence, 0) / inBucket.length;
    const ac = inBucket.length === 0 ? 0 : inBucket.filter((p) => p.correct).length / inBucket.length;
    buckets.push({
      lower,
      count: inBucket.length,
      meanConfidence: Math.round(mc * 10_000) / 10_000,
      accuracy: Math.round(ac * 10_000) / 10_000,
    });
  }
  const ece = scored.length === 0
    ? 0
    : scored.reduce((s, p) => s + Math.abs((p.correct ? 1 : 0) - (p.confidence ?? 0)), 0) / scored.length;
  const meanConf = scored.length === 0 ? 0 : scored.reduce((s, p) => s + (p.confidence ?? 0), 0) / scored.length;
  const acc = scored.length === 0 ? 0 : scored.filter((p) => p.correct).length / scored.length;
  return {
    buckets,
    expectedCalibrationError: Math.round(ece * 10_000) / 10_000,
    overConfidence: Math.round((meanConf - acc) * 10_000) / 10_000,
    errorRate: scored.length === 0 ? 0 : Math.round((scored.filter((p) => !p.correct).length / scored.length) * 10_000) / 10_000,
    answered: scored.length,
  };
}

/**
 * Plain-language indicator: OVER_CONFIDENT / UNDER_CONFIDENT / WELL_CALIBRATED
 * / INSUFFICIENT_DATA. Used in the report and API response (§8).
 */
export function calibrationVerdict(report: CalibrationReport): {
  verdict: 'OVER_CONFIDENT' | 'UNDER_CONFIDENT' | 'WELL_CALIBRATED' | 'INSUFFICIENT_DATA';
  detail: string;
} {
  if (report.answered < 20) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      detail: `${report.answered} answered predictions — treat calibration numbers as indicative only`,
    };
  }
  const oc = report.overConfidence;
  if (oc > 0.1) return { verdict: 'OVER_CONFIDENT', detail: `mean confidence exceeds accuracy by ${oc}` };
  if (oc < -0.1) return { verdict: 'UNDER_CONFIDENT', detail: `accuracy exceeds mean confidence by ${Math.abs(oc)}` };
  return { verdict: 'WELL_CALIBRATED', detail: `mean confidence within ±0.1 of accuracy (delta ${oc})` };
}
