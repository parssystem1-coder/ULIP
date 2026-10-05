import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  validateDecisionResponse,
  type DecisionRequest,
  type DecisionResponse,
} from '../src/interfaces.ts';

function req(): DecisionRequest {
  return {
    question: 'Which specialty is most likely?',
    options: [
      { id: 'hair-coloring', label: 'Hair Coloring' },
      { id: 'balayage', label: 'Balayage' },
      { id: 'unknown', label: 'Unknown' },
    ],
    context: { taskType: 'CLASSIFICATION', facts: [] },
  };
}

test('accepts a valid complete distribution', () => {
  const res: DecisionResponse = {
    probabilities: [
      { optionId: 'hair-coloring', probability: 0.62 },
      { optionId: 'balayage', probability: 0.29 },
      { optionId: 'unknown', probability: 0.09 },
    ],
    selectedOptionId: 'hair-coloring',
    provider: 'jev',
    modelVersion: 'jev-1',
  };
  assert.deepEqual(validateDecisionResponse(req(), res), { ok: true, errors: [] });
});

test('rejects probabilities that do not sum to 1', () => {
  const res: DecisionResponse = {
    probabilities: [
      { optionId: 'hair-coloring', probability: 0.6 },
      { optionId: 'balayage', probability: 0.2 },
      { optionId: 'unknown', probability: 0.1 },
    ],
    provider: 'jev',
    modelVersion: 'jev-1',
  };
  const v = validateDecisionResponse(req(), res);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('sum to 1')));
});

test('rejects out-of-range, NaN and duplicate probabilities', () => {
  const res: DecisionResponse = {
    probabilities: [
      { optionId: 'hair-coloring', probability: 1.5 },
      { optionId: 'balayage', probability: Number.NaN },
      { optionId: 'unknown', probability: -0.1 },
    ],
    provider: 'jev',
    modelVersion: 'jev-1',
  };
  const v = validateDecisionResponse(req(), res);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 3);
});

test('rejects unknown/missing option ids and positional A/B/C keys', () => {
  const res: DecisionResponse = {
    probabilities: [
      { optionId: 'A', probability: 0.5 },
      { optionId: 'B', probability: 0.5 },
    ],
    provider: 'jev',
    modelVersion: 'jev-1',
  };
  const v = validateDecisionResponse(req(), res);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('unknown optionId')));
  assert.ok(v.errors.some((e) => e.includes('missing probability')));
});

test('rejects selectedOptionId outside the request options', () => {
  const res: DecisionResponse = {
    probabilities: [
      { optionId: 'hair-coloring', probability: 0.7 },
      { optionId: 'balayage', probability: 0.2 },
      { optionId: 'unknown', probability: 0.1 },
    ],
    selectedOptionId: 'nonexistent',
    provider: 'jev',
    modelVersion: 'jev-1',
  };
  const v = validateDecisionResponse(req(), res);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('selectedOptionId')));
});
