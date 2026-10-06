/**
 * Report rendering (Phase 17 §10) — deterministic text output for the CLI and
 * the API read side. Machine state stays in the typed records; this module is
 * presentation only.
 */

import type { EvalRunRecord, RegressionReport } from './contracts.ts';
import { renderRegressionReport } from './regression.ts';

/** One-line summary of a run record. */
export function summarizeRun(run: EvalRunRecord): string {
  const m = run.metrics;
  return [
    `run ${run.runId}`,
    `arm=${run.arm}`,
    `status=${run.armStatus}`,
    `dataset=${run.versions.datasetVersion}`,
    `provider=${run.versions.provider}/${run.versions.model}`,
    `prompt=${run.versions.promptVersion}`,
    `taxonomy=v${run.versions.taxonomyVersion}`,
    `policy=${run.versions.scoringPolicyVersion}`,
    `cases=${m.totalCases}`,
    `accuracy=${m.overall.accuracy}`,
    `macroF1=${m.macroF1}`,
    `coverage=${m.coverage}`,
    `abstention=${m.abstentionRate}`,
    `outcomeAcc=${m.outcomeAccuracy}`,
    `ECE=${m.calibration.expectedCalibrationError}`,
    `latencyP95=${m.latency.p95Ms}ms`,
  ].join(' | ');
}

/** Full per-dimension + per-tag report for console output. */
export function renderRunReport(run: EvalRunRecord): string {
  const m = run.metrics;
  const lines: string[] = [];
  lines.push(summarizeRun(run));
  if (run.armReason !== null) lines.push(`arm note: ${run.armReason}`);
  lines.push('');
  lines.push('per-dimension:');
  for (const [dim, cm] of Object.entries(m.byDimension)) {
    lines.push(
      `  ${dim.padEnd(14)} support=${String(cm.support).padStart(3)} acc=${cm.accuracy.toFixed(3)} P=${cm.precision.toFixed(3)} R=${cm.recall.toFixed(3)} F1=${cm.f1.toFixed(3)} abst=${cm.abstentions} cov=${cm.coverage.toFixed(3)}`,
    );
  }
  lines.push('');
  lines.push('calibration (answered=' + m.calibration.answered + '):');
  for (const b of m.calibration.buckets) {
    lines.push(
      `  [${b.lower.toFixed(1)}-${(b.lower + 0.1).toFixed(1)}) n=${String(b.count).padStart(3)} meanConf=${b.meanConfidence.toFixed(3)} acc=${b.accuracy.toFixed(3)}`,
    );
  }
  lines.push('');
  lines.push('score evaluation:');
  for (const d of m.scoreEvaluation.dimensions) {
    lines.push(
      `  ${d.dimension.padEnd(16)} mean=${d.mean.toFixed(1)} min=${d.min} max=${d.max} zeros=${(d.zeroShare * 100).toFixed(0)}% maxCorr=${d.maxCorrelation.toFixed(3)}`,
    );
  }
  const sep = m.scoreEvaluation.separation;
  lines.push(
    `  separation: qualified=${sep.qualifiedMeanPriority?.toFixed(1) ?? 'n/a'} rejected=${sep.rejectedMeanPriority?.toFixed(1) ?? 'n/a'} gap=${sep.gap?.toFixed(1) ?? 'n/a'} separates=${sep.separates}`,
  );
  if (Object.keys(m.byTag).length > 0) {
    lines.push('');
    lines.push('per-tag:');
    for (const [tag, tm] of Object.entries(m.byTag)) {
      lines.push(`  ${tag.padEnd(16)} n=${String(tm.support).padStart(2)} acc=${tm.accuracy.toFixed(3)} F1=${tm.f1.toFixed(3)}`);
    }
  }
  return lines.join('\n');
}

export { renderRegressionReport };
