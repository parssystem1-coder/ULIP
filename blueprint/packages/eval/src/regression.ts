/**
 * Regression harness (Phase 17 §10, §11).
 *
 * Compares a current run against the persisted baseline metric-by-metric.
 * Metric direction matters: accuracy/F1 drops are regressions, while error
 * rates (abstention, ECE, taxonomy errors) REGRESS WHEN THEY RISE. Overall
 * accuracy alone is never the release criterion — findings are per-category
 * (dimension / tag) so a change that quietly breaks one label space is visible.
 */

import type {
  EvalRunMetrics,
  EvalRunRecord,
  RegressionFinding,
  RegressionReport,
} from './contracts.ts';

/** Absolute degradation beyond this counts as a regression (per severity). */
export const REGRESSION_THRESHOLDS = { CRITICAL: 0.1, MAJOR: 0.05, MINOR: 0.02 } as const;

/**
 * Latency lives on a MILLISECOND scale, not the 0–1 rate scale of every other
 * metric — comparing ms deltas against the rate thresholds made 1 ms of
 * machine noise a CRITICAL regression. Latency gets its own absolute-ms
 * tolerances (sub-10 ms differences are scheduler/clock noise; 50 ms+ is a
 * real degradation). Accuracy/rate gates are unchanged.
 */
export const LATENCY_THRESHOLDS_MS = { CRITICAL: 50, MAJOR: 25, MINOR: 10 } as const;

type Direction = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

interface MetricSpec {
  path: string;
  category: string;
  direction: Direction;
  get(metrics: EvalRunMetrics): number;
}

const dimKeys = ['businessType', 'industry', 'specialty', 'subSpecialty', 'brand', 'location'] as const;
const tagOf = (m: EvalRunMetrics): string[] => Object.keys(m.byTag).sort();
const firstTag = (m: EvalRunMetrics, tag: string) => m.byTag[tag] ?? { support: 0, accuracy: 0, f1: 0 };

function specsFor(template: EvalRunMetrics): MetricSpec[] {
  const specs: MetricSpec[] = [
    { path: 'overall.accuracy', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.overall.accuracy },
    { path: 'overall.precision', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.overall.precision },
    { path: 'overall.recall', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.overall.recall },
    { path: 'overall.f1', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.overall.f1 },
    { path: 'macroF1', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.macroF1 },
    { path: 'outcomeAccuracy', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.outcomeAccuracy },
    { path: 'coverage', category: 'overall', direction: 'HIGHER_IS_BETTER', get: (m) => m.coverage },
    { path: 'abstentionRate', category: 'overall', direction: 'LOWER_IS_BETTER', get: (m) => m.abstentionRate },
    { path: 'calibration.expectedCalibrationError', category: 'calibration', direction: 'LOWER_IS_BETTER', get: (m) => m.calibration.expectedCalibrationError },
    { path: 'calibration.errorRate', category: 'calibration', direction: 'LOWER_IS_BETTER', get: (m) => m.calibration.errorRate },
    { path: 'latency.meanMs', category: 'latency', direction: 'LOWER_IS_BETTER', get: (m) => m.latency.meanMs },
  ];
  for (const dim of dimKeys) {
    specs.push({ path: `byDimension.${dim}.f1`, category: dim, direction: 'HIGHER_IS_BETTER', get: (m) => m.byDimension[dim].f1 });
    specs.push({ path: `byDimension.${dim}.accuracy`, category: dim, direction: 'HIGHER_IS_BETTER', get: (m) => m.byDimension[dim].accuracy });
    specs.push({ path: `byDimension.${dim}.coverage`, category: dim, direction: 'HIGHER_IS_BETTER', get: (m) => m.byDimension[dim].coverage });
  }
  for (const tag of tagOf(template)) {
    specs.push({ path: `byTag.${tag}.f1`, category: tag, direction: 'HIGHER_IS_BETTER', get: (m) => firstTag(m, tag).f1 });
    specs.push({ path: `byTag.${tag}.accuracy`, category: tag, direction: 'HIGHER_IS_BETTER', get: (m) => firstTag(m, tag).accuracy });
  }
  return specs;
}

function severityFor(delta: number, thresholds: { CRITICAL: number; MAJOR: number; MINOR: number }): RegressionFinding['severity'] {
  if (delta >= thresholds.CRITICAL) return 'CRITICAL';
  if (delta >= thresholds.MAJOR) return 'MAJOR';
  return 'MINOR';
}

/**
 * Compares two run records. A regression exists when a metric moved in the
 * wrong direction by more than MINOR threshold. `improved` lists metrics that
 * moved in the right direction by more than MINOR threshold.
 */
export function compareRuns(baseline: EvalRunRecord, current: EvalRunRecord): RegressionReport {
  const specs = specsFor(baseline.metrics);
  const findings: RegressionFinding[] = [];
  const improved: { metric: string; delta: number }[] = [];

  for (const spec of specs) {
    const base = spec.get(baseline.metrics);
    const curr = spec.get(current.metrics);
    const delta = Math.round((curr - base) * 10_000) / 10_000;
    const worsened = spec.direction === 'HIGHER_IS_BETTER' ? delta < 0 : delta > 0;
    const thresholds = spec.category === 'latency' ? LATENCY_THRESHOLDS_MS : REGRESSION_THRESHOLDS;
    const magnitude = Math.abs(delta);
    if (worsened && magnitude > thresholds.MINOR) {
      findings.push({
        metric: spec.path,
        category: spec.category,
        baseline: base,
        current: curr,
        delta,
        threshold: thresholds.MINOR,
        severity: severityFor(magnitude, thresholds),
      });
    } else if (!worsened && magnitude > thresholds.MINOR) {
      improved.push({ metric: spec.path, delta });
    }
  }

  const hasRegressions = findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'MAJOR');

  return {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    datasetVersion: current.versions.datasetVersion,
    datasetVersionChanged: baseline.versions.datasetVersion !== current.versions.datasetVersion,
    findings: findings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    improved: improved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    hasRegressions,
  };
}

/** Console/report rendering of a regression comparison. */
export function renderRegressionReport(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push(`regression comparison: baseline ${report.baselineRunId} → current ${report.currentRunId}`);
  lines.push(`dataset: ${report.datasetVersion}${report.datasetVersionChanged ? ' (CHANGED vs baseline — compare with care)' : ''}`);
  if (report.findings.length === 0) {
    lines.push('no regressions above threshold');
  } else {
    for (const f of report.findings) {
      lines.push(
        `[${f.severity}] ${f.metric}: ${f.baseline} → ${f.current} (delta ${f.delta})`,
      );
    }
  }
  for (const imp of report.improved.slice(0, 10)) {
    lines.push(`improved: ${imp.metric} (+${imp.delta})`);
  }
  lines.push(`release gate: ${report.hasRegressions ? 'BLOCKED — CRITICAL/MAJOR regressions present' : 'PASS'}`);
  return lines.join('\n');
}
