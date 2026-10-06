import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  enforceEvidenceFirst,
  parseExtractionProfile,
  validateExtractionOutput,
  type ProfileExtractionInput,
} from '../src/index.ts';

const INPUT: ProfileExtractionInput = {
  profileText: 'text',
  locationHints: [],
  contentSamples: [{ contentId: 'e1', text: 'HP printer parts wholesaler Tehran' }],
  taxonomySnapshot: [],
  locale: 'en',
};

const OK = {
  businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['e1'], availability: 'AVAILABLE' },
  city: { value: 'Tehran', confidence: 0.8, evidenceIds: ['e1'], availability: 'AVAILABLE', provenance: 'EXPLICIT' },
};

test('accepts a contract-valid extraction', () => {
  assert.deepEqual(validateExtractionOutput(INPUT, OK), { ok: true, errors: [] });
});

test('rejects unknown evidence references', () => {
  const bad = { businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['ghost'], availability: 'AVAILABLE' } };
  const verdict = validateExtractionOutput(INPUT, bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('unknown evidence id')));
});

test('rejects a claimed value with no evidence reference', () => {
  const bad = { industry: { value: 'Printing', confidence: 0.5, evidenceIds: [], availability: 'AVAILABLE' } };
  const verdict = validateExtractionOutput(INPUT, bad);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('evidence-first')));
});

test('rejects out-of-range confidence and bad availability', () => {
  const verdict = validateExtractionOutput(INPUT, {
    businessType: { value: 'X', confidence: 1.5, evidenceIds: ['e1'], availability: 'AVAILABLE' },
    industry: { value: 'Y', confidence: 0.5, evidenceIds: ['e1'], availability: 'MAYBE' },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('[0,1]')));
  assert.ok(verdict.errors.some((e) => e.includes('availability')));
});

test('missing availability is normalized to INFERRED, never AVAILABLE', () => {
  const profile = parseExtractionProfile({
    businessType: { value: 'Wholesaler', confidence: 0.7, evidenceIds: ['e1'] },
  });
  assert.equal(profile.businessType?.availability, 'INFERRED');
});

test('enforceEvidenceFirst demotes unsupported fields but keeps them visible', () => {
  const profile = parseExtractionProfile({
    businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['e1'], availability: 'AVAILABLE' },
    industry: { value: 'Printing', confidence: 0.9, evidenceIds: ['ghost'], availability: 'AVAILABLE' },
  });
  const result = enforceEvidenceFirst(profile, new Set(['e1']));
  assert.equal(result.profile.businessType?.availability, 'AVAILABLE');
  assert.equal(result.profile.industry?.availability, 'UNAVAILABLE');
  assert.equal(result.profile.industry?.confidence, 0);
  assert.deepEqual(result.demoted, ['industry']);
  // The demoted value stays visible as an uncertain note (not a fact).
  assert.equal(result.profile.industry?.value, 'Printing');
});
