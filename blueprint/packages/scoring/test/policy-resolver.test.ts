import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  resolvePolicy,
  validateWeights,
  computePriority,
  mapReviewOutcome,
  score,
  type ScoringPolicyVersionRow,
} from '../src/policy-resolver.ts';
import type { PolicyThresholds, PolicyWeights } from '../src/contracts.ts';

const W: PolicyWeights = { relevance: 0.4, audienceQuality: 0.2, activity: 0.25, confidence: 0.15 };
const T: PolicyThresholds = { qualifiedMin: 80, reviewMin: 60, rejectMax: 40 };

function row(over: Partial<ScoringPolicyVersionRow> = {}): ScoringPolicyVersionRow {
  return {
    id: 'v1',
    policyId: 'p1',
    version: 1,
    weights: W,
    thresholds: T,
    status: 'ACTIVE',
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
    ...over,
  };
}

test('resolvePolicy picks the active version effective at time', () => {
  const p = resolvePolicy([row()]);
  assert.ok(p);
  assert.equal(p.version, 1);
});

test('resolvePolicy ignores retired and future versions, picks latest effective', () => {
  const p = resolvePolicy([
    row({ id: 'old', version: 1, effectiveFrom: '2026-01-01T00:00:00Z' }),
    row({ id: 'retired', version: 2, status: 'RETIRED', effectiveFrom: '2026-02-01T00:00:00Z' }),
    row({ id: 'future', version: 3, effectiveFrom: '2099-01-01T00:00:00Z' }),
    row({ id: 'new', version: 4, effectiveFrom: '2026-03-01T00:00:00Z' }),
  ]);
  assert.ok(p);
  assert.equal(p.versionId, 'new');
});

test('resolvePolicy returns null when nothing is effective', () => {
  assert.equal(resolvePolicy([row({ effectiveFrom: '2099-01-01T00:00:00Z' })]), null);
});

test('validateWeights rejects weights that do not sum to 1', () => {
  assert.equal(validateWeights(W).ok, true);
  const bad = validateWeights({ relevance: 0.5, audienceQuality: 0.5, activity: 0.5, confidence: 0.5 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0]?.includes('sum to 1'));
});

test('computePriority is the weighted aggregate of independent dimensions', () => {
  const dims = { relevance: 90, audienceQuality: 60, activity: 80, confidence: 95 };
  // 0.4*90 + 0.2*60 + 0.25*80 + 0.15*95 = 36+12+20+14.25 = 82.25
  assert.equal(computePriority(dims, W), 82.25);
});

test('mapReviewOutcome maps by policy thresholds, middle band → REVIEW', () => {
  assert.equal(mapReviewOutcome(85, T), 'QUALIFIED');
  assert.equal(mapReviewOutcome(70, T), 'REVIEW_REQUIRED');
  assert.equal(mapReviewOutcome(30, T), 'REJECTED');
  assert.equal(mapReviewOutcome(50, T), 'REVIEW_REQUIRED');
});

test('score clamps dimensions and returns policy version label', () => {
  const policy = resolvePolicy([row()])!;
  const result = score(
    { relevance: 120, audienceQuality: -5, activity: 80, confidence: 95 },
    policy,
    'default@1',
  );
  assert.equal(result.relevance, 100);
  assert.equal(result.audienceQuality, 0);
  assert.equal(result.scoringPolicyVersion, 'default@1');
  assert.ok(['QUALIFIED', 'REVIEW_REQUIRED', 'REJECTED'].includes(result.reviewOutcome));
});
