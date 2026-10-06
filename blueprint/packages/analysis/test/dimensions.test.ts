import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapReviewOutcome, score, validateWeights, type ResolvedScoringPolicy } from '@ulip/scoring';
import { computeDimensions } from '../src/dimensions.ts';
import { BOOTSTRAP_SCORING_POLICY } from '../src/policy.ts';
import { makeLeadContext } from './fakes.ts';

const POLICY: ResolvedScoringPolicy = {
  policyId: 'p1',
  versionId: 'v1',
  version: 1,
  weights: BOOTSTRAP_SCORING_POLICY.weights,
  thresholds: BOOTSTRAP_SCORING_POLICY.thresholds,
};

test('bootstrap policy weights are valid and persisted-shaped', () => {
  assert.deepEqual(validateWeights(BOOTSTRAP_SCORING_POLICY.weights), { ok: true, errors: [] });
  assert.equal(BOOTSTRAP_SCORING_POLICY.thresholds.qualifiedMin, 80);
});

test('dimensions are independent and every contribution carries evidence', () => {
  const evidence = [
    { id: 'ev-name', type: 'PROFILE_METADATA' as const, content: 'name: چاپخانه تهران' },
    { id: 'ev-bio', type: 'BIO_TEXT' as const, content: 'عمده‌فروش قطعات پرینتر HP' },
    { id: 'ev-city', type: 'LOCATION_SIGNAL' as const, content: 'تهران' },
  ];
  const result = computeDimensions({
    profile: {
      businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['ev-bio'], availability: 'AVAILABLE' },
      industry: { value: 'Printing', confidence: 0.8, evidenceIds: ['ev-bio'], availability: 'AVAILABLE' },
      specialties: [{ value: 'Printer Parts', confidence: 0.8, evidenceIds: ['ev-bio'], availability: 'AVAILABLE' }],
      brands: [{ value: 'HP', confidence: 0.9, evidenceIds: ['ev-bio'], availability: 'AVAILABLE' }],
      city: { value: 'Tehran', confidence: 0.85, evidenceIds: ['ev-city'], availability: 'AVAILABLE', provenance: 'EXPLICIT' },
    },
    evidence: evidence.map((e) => ({
      id: e.id,
      leadId: 'lead',
      evidenceType: e.type,
      sourceType: 'FAKE',
      sourceReference: `ref/${e.id}`,
      content: e.content,
      contentHash: e.id,
      retrievedAt: '2026-01-01T00:00:00.000Z',
      confidence: 0.9,
      metadata: {},
    })),
    context: makeLeadContext(),
  });

  assert.ok(result.dimensions.relevance > 60, `relevance ${result.dimensions.relevance}`);
  assert.ok(result.dimensions.audienceQuality > 40, `audience ${result.dimensions.audienceQuality}`);
  assert.ok(result.dimensions.confidence > 50, `confidence ${result.dimensions.confidence}`);
  for (const dim of ['relevance', 'audienceQuality', 'activity', 'confidence'] as const) {
    assert.equal(result.dimensions[dim] >= 0 && result.dimensions[dim] <= 100, true);
  }
  const dims = new Set(result.reasons.map((r) => r.dimension));
  assert.equal(dims.has('relevance'), true);
  assert.equal(dims.has('audienceQuality'), true);
  assert.equal(dims.has('confidence'), true);
  // Reasons never fabricate support: every cited id exists.
  const ids = new Set(evidence.map((e) => e.id));
  for (const reason of result.reasons) {
    for (const id of reason.evidenceIds) assert.equal(ids.has(id), true, `unknown evidence ${id}`);
  }
});

test('absent activity signals score 0 and say so explicitly', () => {
  const result = computeDimensions({
    profile: { specialties: [] },
    evidence: [],
    context: makeLeadContext({ contents: [], rawPayloads: [] }),
  });
  assert.equal(result.dimensions.activity, 0);
  assert.equal(result.dimensions.confidence, 0);
  const reason = result.reasons.find((r) => r.code === 'NO_ACTIVITY_SIGNALS');
  assert.ok(reason !== undefined);
  assert.equal(reason.evidenceIds.length, 0);
});

test('unsupported fields are reported as uncertain, not as facts', () => {
  const result = computeDimensions({
    profile: {
      businessType: { value: 'Wholesaler', confidence: 0, evidenceIds: [], availability: 'UNAVAILABLE' },
      specialties: [],
    },
    evidence: [],
    context: makeLeadContext(),
  });
  const uncertain = result.uncertain.find((u) => u.field === 'businessType');
  assert.ok(uncertain !== undefined);
  assert.equal(uncertain.value, 'Wholesaler');
  assert.ok(uncertain.reason.includes('not used as a fact'));
});

test('policy thresholds own the review outcome (never code constants)', () => {
  const dims = { relevance: 95, audienceQuality: 90, activity: 90, confidence: 90 };
  const qualified = score(dims, POLICY, 'v1/v1');
  assert.equal(qualified.reviewOutcome, 'QUALIFIED');
  assert.equal(qualified.priority, Math.round((95 * 0.4 + 90 * 0.2 + 90 * 0.25 + 90 * 0.15) * 100) / 100);

  const rejected = score({ relevance: 10, audienceQuality: 10, activity: 10, confidence: 10 }, POLICY, 'v1/v1');
  assert.equal(rejected.reviewOutcome, 'REJECTED');

  const review = score({ relevance: 70, audienceQuality: 60, activity: 60, confidence: 60 }, POLICY, 'v1/v1');
  assert.equal(review.reviewOutcome, 'REVIEW_REQUIRED');

  // Threshold mapping is the policy's, not the engine's.
  assert.equal(mapReviewOutcome(80, POLICY.thresholds), 'QUALIFIED');
  assert.equal(mapReviewOutcome(79, POLICY.thresholds), 'REVIEW_REQUIRED');
  assert.equal(mapReviewOutcome(40, POLICY.thresholds), 'REJECTED');
  assert.equal(
    mapReviewOutcome(50, { qualifiedMin: 50, reviewMin: 40, rejectMax: 10 }),
    'QUALIFIED',
  );
});

test('scoring policy version is persisted on every score', () => {
  const result = score({ relevance: 80, audienceQuality: 80, activity: 80, confidence: 80 }, POLICY, 'v3/abcd1234');
  assert.equal(result.scoringPolicyVersion, 'v3/abcd1234');
});
