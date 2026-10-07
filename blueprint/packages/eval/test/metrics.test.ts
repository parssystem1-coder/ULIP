/**
 * Metrics, calibration, error taxonomy and regression tests (Phase 17 §4, §5,
 * §8, §11, §16). Synthetic fixtures with known answers — every number is
 * hand-computable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  EvalCaseResult,
  EvalLabelOutcome,
  EvalRunRecord,
  EvalVersions,
} from '../src/contracts.ts';
import { classificationMetrics, aggregateRunMetrics, calibrationReport } from '../src/metrics.ts';
import { buildCalibrationReport, calibrationVerdict } from '../src/calibration.ts';
import { evaluateScores } from '../src/score-eval.ts';
import { compareRuns, renderRegressionReport } from '../src/regression.ts';
import { classifyError, refineWithTaxonomyContext } from '../src/errors.ts';
import type { EvalCase } from '../src/contracts.ts';

// ---------------------------------------------------------------- metrics

function outcome(caseId: string, dimension: EvalLabelOutcome['dimension'], expected: string[], actual: string[], confidence: number | null): EvalLabelOutcome {
  return {
    dimension,
    expected,
    actual,
    correct:
      [...expected].sort().join('|') === [...actual].sort().join('|'),
    confidence: actual.length > 0 ? confidence : null,
    abstained: expected.length > 0 && actual.length === 0,
  };
}

test('classification metrics: accuracy, precision, recall, F1, confusion matrix', () => {
  // 4 pairs: 3 exact matches, 1 wrong; abstention tracked separately.
  const pairs = [
    { expected: ['Wholesaler'], actual: ['Wholesaler'] },
    { expected: ['Retailer'], actual: ['Retailer'] },
    { expected: ['Wholesaler'], actual: ['Wholesaler'] },
    { expected: ['Printing'], actual: ['Beauty'] },
  ];
  const m = classificationMetrics(pairs, 1, new Map());
  assert.equal(m.support, 5); // 4 answered + 1 abstention
  assert.equal(m.accuracy, 0.75);
  // Micro one-vs-rest: TP=3, FP=1, FN=1 → P=R=F1=0.75
  assert.equal(m.precision, 0.75);
  assert.equal(m.recall, 0.75);
  assert.ok(Math.abs(m.f1 - 0.75) < 1e-9);
  assert.equal(m.abstentions, 1);
  assert.equal(m.coverage, 0.8);
  // Confusion matrix over the sorted aliasKey-normalized union of labels.
  assert.deepEqual(m.confusionMatrix.labels, ['beauty', 'printing', 'retailer', 'wholesaler']);
  const idx = Object.fromEntries(m.confusionMatrix.labels.map((l, i) => [l, i]));
  const cm = m.confusionMatrix.matrix;
  assert.equal(cm[idx['wholesaler'] as number]?.[idx['wholesaler'] as number], 2);
  assert.equal(cm[idx['printing'] as number]?.[idx['beauty'] as number], 1);
});

test('multi-label specialty pairs: set equality + partial-credit micro P/R', () => {
  const pairs = [
    { expected: ['Hair Coloring', 'Balayage'], actual: ['Hair Coloring', 'Balayage'] },
    { expected: ['Hair Coloring'], actual: ['Hair Coloring', 'Balayage'] }, // over-claim inside labeled dim
  ];
  const m = classificationMetrics(pairs, 0, new Map());
  assert.equal(m.accuracy, 0.5); // only first pair exactly matches
  // TP=3, FP=1, FN=0 → P=0.75, R=1, F1=6/7 (rounded to 4dp)
  assert.equal(m.precision, 0.75);
  assert.equal(m.recall, 1);
  assert.ok(Math.abs(m.f1 - 6 / 7) < 1e-4);
});

// ------------------------------------------------------------- calibration

const CAL_CASES: EvalLabelOutcome[] = [
  outcome('c1', 'businessType', ['A'], ['A'], 0.95),
  outcome('c2', 'businessType', ['A'], ['A'], 0.55),
  outcome('c3', 'businessType', ['A'], ['B'], 0.95),
  outcome('c4', 'industry', ['I'], ['I'], 0.65),
  outcome('c5', 'industry', ['I'], ['I'], 0.75),
];

test('calibration: buckets, ECE, over-confidence indicator', () => {
  const r = calibrationReport(CAL_CASES);
  assert.equal(r.answered, 5);
  const b95 = r.buckets.find((b) => b.lower === 0.9);
  assert.ok(b95 !== undefined);
  assert.equal(b95.count, 2);
  assert.equal(b95.meanConfidence, 0.95);
  assert.equal(b95.accuracy, 0.5); // 1 of 2 correct
  // ECE = mean |correct - conf| = (0.05 + 0.45 + 0.95 + 0.35 + 0.25) / 5 = 0.41
  assert.equal(r.expectedCalibrationError, 0.41);
  // meanConf = (0.95+0.55+0.95+0.65+0.75)/5 = 0.77; acc = 4/5 = 0.8 → -0.03 (slightly under-confident)
  assert.ok(Math.abs(r.overConfidence - -0.03) < 1e-9);
});

test('buildCalibrationReport matches run aggregation; verdict reacts to over-confidence', () => {
  const standalone = buildCalibrationReport(CAL_CASES);
  assert.equal(standalone.expectedCalibrationError, 0.41);
  const v = calibrationVerdict({ ...standalone, overConfidence: 0.3, answered: 50 });
  assert.equal(v.verdict, 'OVER_CONFIDENT');
  const v2 = calibrationVerdict({ ...standalone, answered: 3 });
  assert.equal(v2.verdict, 'INSUFFICIENT_DATA');
});

// -------------------------------------------------------- aggregate metrics

function makeCaseResult(caseId: string, outcomes: EvalLabelOutcome[], priority: number, expectedOutcome: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED' | undefined, actualOutcome: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'REJECTED'): EvalCaseResult {
  const labeled = outcomes.filter((o) => o.expected.length > 0);
  return {
    caseId,
    arm: 'RULES_ONLY',
    versions: {
      datasetVersion: '1.0.0', provider: 'p', model: 'm', promptVersion: 'pr',
      schemaVersion: '1', taxonomyVersion: 1, scoringPolicyVersion: 'bootstrap-v1',
    },
    outcomes,
    exactMatch: labeled.every((o) => o.correct),
    dimensionAccuracy: labeled.length === 0 ? 1 : labeled.filter((o) => o.correct).length / labeled.length,
    meanConfidence: null,
    miscalibrated: false,
    reviewOutcome: { expected: expectedOutcome ?? null, actual: actualOutcome, correct: expectedOutcome === actualOutcome },
    scores: { relevance: priority, audienceQuality: priority, activity: priority, confidence: priority, priority },
    latencyMs: 1,
    tokens: null,
    estimatedCost: null,
    errorCategory: null,
    errorDetail: null,
  };
}

test('aggregateRunMetrics: per-dimension, macroF1, outcomeAccuracy, byTag, abstention', () => {
  const r1 = makeCaseResult(
    'c1',
    [
      outcome('c1', 'businessType', ['Wholesaler'], ['Wholesaler'], 0.9),
      outcome('c1', 'location', ['Tehran'], [], 0.9), // abstained
      outcome('c1', 'brand', [], ['GhostBrand'], 0.9), // over-claim on unlabeled dim → excluded
    ],
    85,
    'QUALIFIED',
    'QUALIFIED',
  );
  const r2 = makeCaseResult(
    'c2',
    [
      outcome('c2', 'businessType', ['Retailer'], ['Retailer'], 0.9),
      outcome('c2', 'location', ['Tehran'], ['Tehran'], 0.9),
    ],
    30,
    'REJECTED',
    'REVIEW_REQUIRED',
  );
  const tags = new Map([
    ['c1', ['CANONICAL', 'PERSIAN'] as readonly string[]],
    ['c2', ['ENGLISH'] as readonly string[]],
  ]);
  const m = aggregateRunMetrics([r1, r2], tags);

  assert.equal(m.totalCases, 2);
  // overall pairs: bt(c1) ok, bt(c2) ok, loc(c2) ok → 3 answered, 1 abstention
  assert.equal(m.overall.support, 4);
  assert.equal(m.overall.accuracy, 1);
  assert.equal(m.abstentionRate, 0.25);
  assert.equal(m.coverage, 0.75);
  assert.equal(m.byDimension.businessType.accuracy, 1);
  assert.equal(m.byDimension.location.support, 2);
  assert.equal(m.byDimension.location.abstentions, 1);
  assert.equal(m.byDimension.brand.support, 0); // unlabeled dim excluded
  // macroF1 = mean over ALL six dimensions; 4 dimensions have no pairs here → f1 0.
  assert.ok(Math.abs(m.macroF1 - 2 / 6) < 1e-4);
  assert.equal(m.outcomeAccuracy, 0.5); // c1 correct, c2 wrong
  assert.ok(m.byTag['CANONICAL'] !== undefined);
  assert.equal(m.byTag['CANONICAL']?.accuracy, 1);
  assert.ok(m.byTag['ENGLISH'] !== undefined);
});

// --------------------------------------------------------- score evaluation

test('score evaluation: separation, zero-share dominance, correlations', () => {
  const good = makeCaseResult('g', [outcome('g', 'businessType', ['W'], ['W'], 0.9)], 90, 'QUALIFIED', 'QUALIFIED');
  const bad = makeCaseResult('b', [outcome('b', 'businessType', ['W'], ['W'], 0.9)], 10, 'REJECTED', 'REJECTED');
  const { report, findings } = evaluateScores([good, bad]);
  assert.equal(report.separation.qualifiedMeanPriority, 90);
  assert.equal(report.separation.rejectedMeanPriority, 10);
  assert.equal(report.separation.gap, 80);
  assert.equal(report.separation.separates, true);
  // All dimensions perfectly correlated with each other in this fixture.
  assert.ok(report.dimensions[0]!.maxCorrelation > 0.99);
  // Nothing is zero-dominated in this fixture.
  assert.deepEqual(report.dominatedByMissingData, []);
  // Perfect correlation is correctly flagged as an over-correlation finding.
  assert.ok((findings['relevance'] ?? []).some((f) => f.startsWith('overly correlated')));
});

// ---------------------------------------------------------- error taxonomy

const baseCase: EvalCase = {
  caseId: 'x',
  description: '',
  tags: [],
  locale: 'en',
  input: { name: 'Sample', bio: 'wholesaler of printer parts' },
  expected: { businessType: 'Wholesaler', industry: null, specialty: [], subSpecialty: [], brand: [], location: null },
};

test('error taxonomy: SOURCE_DATA_MISSING when nothing observable exists', () => {
  const empty = { ...baseCase, input: { name: 'Ghost' } };
  const res = makeCaseResult('x', [outcome('x', 'businessType', ['Wholesaler'], [], 0.9)], 10, undefined, 'REVIEW_REQUIRED');
  assert.equal(classifyError(empty, res), 'SOURCE_DATA_MISSING');
});

test('error taxonomy: GROUNDING_FAILURE on abstention with data present', () => {
  const res = makeCaseResult('x', [outcome('x', 'businessType', ['Wholesaler'], [], 0.9)], 10, undefined, 'REVIEW_REQUIRED');
  assert.equal(classifyError(baseCase, res), 'GROUNDING_FAILURE');
});

test('error taxonomy: MODEL_MISUNDERSTANDING on a wrong canonical answer', () => {
  const res = makeCaseResult('x', [outcome('x', 'businessType', ['Wholesaler'], ['Retailer'], 0.9)], 10, undefined, 'REVIEW_REQUIRED');
  const base = classifyError(baseCase, res);
  assert.equal(base, 'MODEL_MISUNDERSTANDING');
  // refine: 'Retailer' IS canonical → stays
  assert.equal(refineWithTaxonomyContext(base, baseCase, res, (d, v) => d === 'businessType' && v === 'Retailer'), 'MODEL_MISUNDERSTANDING');
  // refine: non-canonical answer upgrades to TAXONOMY_MISMATCH
  assert.equal(refineWithTaxonomyContext(base, baseCase, res, () => false), 'TAXONOMY_MISMATCH');
});

test('error taxonomy: THRESHOLD_ERROR when labels are right but the outcome is wrong', () => {
  const res = makeCaseResult('x', [outcome('x', 'businessType', ['Wholesaler'], ['Wholesaler'], 0.9)], 45, 'QUALIFIED', 'REVIEW_REQUIRED');
  assert.equal(classifyError(baseCase, res), 'THRESHOLD_ERROR');
});

test('error taxonomy: NORMALIZATION_ERROR for pure over-claims', () => {
  const res = makeCaseResult('x', [outcome('x', 'brand', [], ['GhostBrand'], 0.9)], 45, undefined, 'REVIEW_REQUIRED');
  assert.equal(classifyError(baseCase, res), 'NORMALIZATION_ERROR');
});

// ------------------------------------------------------------- regression

const VERSIONS: EvalVersions = {
  datasetVersion: '1.0.0', provider: 'p', model: 'm', promptVersion: 'pr',
  schemaVersion: '1', taxonomyVersion: 1, scoringPolicyVersion: 'bootstrap-v1',
};

function makeRun(runId: string, metrics: EvalRunRecord['metrics'], datasetVersion = '1.0.0'): EvalRunRecord {
  return {
    runId,
    tenantId: 't',
    versions: { ...VERSIONS, datasetVersion },
    arm: 'LLM_ONLY',
    armStatus: 'EXECUTED',
    armReason: null,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    metrics,
  };
}

const BASE_METRICS = aggregateRunMetrics([
  makeCaseResult('c1', [outcome('c1', 'businessType', ['W'], ['W'], 0.9)], 90, 'QUALIFIED', 'QUALIFIED'),
  makeCaseResult('c2', [outcome('c2', 'businessType', ['R'], ['R'], 0.9)], 20, 'REJECTED', 'REJECTED'),
]);

test('regression: no findings when metrics are identical', () => {
  const report = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', BASE_METRICS));
  assert.equal(report.findings.length, 0);
  assert.equal(report.hasRegressions, false);
  assert.equal(report.datasetVersionChanged, false);
});

test('regression: CRITICAL on a large accuracy drop, MAJOR on a moderate one', () => {
  const dropped = aggregateRunMetrics([
    makeCaseResult('c1', [outcome('c1', 'businessType', ['W'], ['X'], 0.9)], 90, 'QUALIFIED', 'QUALIFIED'),
    makeCaseResult('c2', [outcome('c2', 'businessType', ['R'], ['X'], 0.9)], 20, 'REJECTED', 'REJECTED'),
  ]);
  const report = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', dropped));
  const f = report.findings.find((x) => x.metric === 'overall.accuracy');
  assert.ok(f !== undefined);
  assert.equal(f.severity, 'CRITICAL'); // 1.0 → 0.0
  assert.equal(report.hasRegressions, true);
  assert.ok(report.findings.some((x) => x.metric === 'macroF1'));
});

test('regression: LOWER_IS_BETTER metrics (ECE, abstention) regress when they rise', () => {
  const noisier = aggregateRunMetrics([
    makeCaseResult('c1', [outcome('c1', 'businessType', ['W'], ['W'], 0.5)], 90, 'QUALIFIED', 'QUALIFIED'),
    makeCaseResult('c2', [outcome('c2', 'businessType', ['R'], ['R'], 0.5)], 20, 'REJECTED', 'REJECTED'),
  ]);
  const report = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', noisier));
  // ECE rose from ~0 to ~0.5 → regression on the calibration path
  assert.ok(report.findings.some((f) => f.metric === 'calibration.expectedCalibrationError'));
});

test('regression: dataset version change is flagged, improvements are listed', () => {
  const better = aggregateRunMetrics([
    makeCaseResult('c1', [outcome('c1', 'businessType', ['W'], ['W'], 0.9), outcome('c1', 'location', ['T'], ['T'], 0.9)], 90, 'QUALIFIED', 'QUALIFIED'),
    makeCaseResult('c2', [outcome('c2', 'businessType', ['R'], ['R'], 0.9)], 20, 'REJECTED', 'REJECTED'),
  ]);
  const report = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', better, '1.1.0'));
  assert.equal(report.datasetVersionChanged, true);
  assert.ok(report.improved.some((i) => i.metric === 'overall.accuracy' || i.metric === 'macroF1'));
  const text = renderRegressionReport(report);
  assert.match(text, /CHANGED vs baseline/);
});

test('regression: latency uses ms-scaled tolerances (1 ms of machine noise is not a regression)', () => {
  // Nudge mean latency by ~1 ms (machine/clock noise around the 0/1 boundary).
  const current = JSON.parse(JSON.stringify(BASE_METRICS)) as EvalRunRecord['metrics'];
  current.latency.meanMs = (current.latency.meanMs ?? 0) + 1;
  const report = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', current));
  assert.equal(report.findings.some((f) => f.metric === 'latency.meanMs'), false);
  assert.equal(report.hasRegressions, false);

  // A real latency degradation (100 ms slower) is still caught — CRITICAL.
  const muchSlower = JSON.parse(JSON.stringify(BASE_METRICS)) as EvalRunRecord['metrics'];
  muchSlower.latency.meanMs = (muchSlower.latency.meanMs ?? 0) + 100;
  const blocked = compareRuns(makeRun('base', BASE_METRICS), makeRun('cur', muchSlower));
  const f = blocked.findings.find((x) => x.metric === 'latency.meanMs');
  assert.ok(f !== undefined);
  assert.equal(f.severity, 'CRITICAL');
  assert.equal(blocked.hasRegressions, true);
});
