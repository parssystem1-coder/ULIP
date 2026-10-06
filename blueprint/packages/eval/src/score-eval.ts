/**
 * Score evaluation (Phase 17 §9).
 *
 * Evaluates the five score concepts (relevance, audienceQuality, activity,
 * confidence, priority) against human outcome labels. Detection only:
 *  - separates good/bad leads (priority gap QUALIFIED vs REJECTED)
 *  - is dominated by missing data (zeroShare)
 *  - produces suspicious values (mean near extremes)
 *  - is overly correlated with another dimension (maxCorrelation)
 *
 * It NEVER changes the production scoring policy (§9 non-goal).
 */

import type {
  EvalCaseResult,
  ScoreDimensionDiagnostic,
  ScoreEvaluationReport,
} from './contracts.ts';
import { scoreEvaluationReport } from './metrics.ts';

export const OVER_CORRELATION_THRESHOLD = 0.9;
export const EXTREME_SHARE_THRESHOLD = 0.5;
export const MIN_SEPARATION_GAP = 10;

/** Flags one score dimension with plain-language findings (empty = healthy). */
export function scoreFindings(d: ScoreDimensionDiagnostic): string[] {
  const findings: string[] = [];
  if (d.maxCorrelation >= OVER_CORRELATION_THRESHOLD) {
    findings.push(`overly correlated (max |r| ${d.maxCorrelation})`);
  }
  if (d.zeroShare >= EXTREME_SHARE_THRESHOLD) {
    findings.push(`dominated by missing data (${Math.round(d.zeroShare * 100)}% zeros)`);
  }
  if (d.mean >= 95 || d.mean <= 5) {
    findings.push(`suspiciously ${d.mean >= 95 ? 'high' : 'low'} mean (${d.mean})`);
  }
  return findings;
}

/** Report + per-dimension findings, ready for the API/console report. */
export function evaluateScores(results: readonly EvalCaseResult[]): {
  report: ScoreEvaluationReport;
  findings: Record<string, string[]>;
} {
  const report = scoreEvaluationReport(results);
  const findings: Record<string, string[]> = {};
  for (const d of report.dimensions) {
    const f = scoreFindings(d);
    if (f.length > 0) findings[d.dimension] = f;
  }
  return { report, findings };
}
