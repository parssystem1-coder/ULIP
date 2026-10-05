import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  LEAD_TRANSITION_TABLE,
  FAILURE_POLICY,
  canTransition,
  type ProcessingTransition,
} from '../src/contracts.ts';

test('happy path walks DISCOVERED → QUALIFIED through declared edges only', () => {
  const path: Array<[ProcessingTransition['from'], ProcessingTransition['event'], ProcessingTransition['to']]> = [
    ['DISCOVERED', 'RAW_STORED', 'RAW_STORED'],
    ['RAW_STORED', 'NORMALIZED', 'NORMALIZED'],
    ['NORMALIZED', 'DEDUP_RESOLVED', 'DEDUP_CHECKED'],
    ['DEDUP_CHECKED', 'QUEUE_ANALYSIS', 'ANALYSIS_PENDING'],
    ['ANALYSIS_PENDING', 'ANALYSIS_STARTED', 'ANALYZING'],
    ['ANALYZING', 'ANALYSIS_SUCCEEDED', 'SCORED'],
    ['SCORED', 'THRESHOLD_MAP', 'QUALIFIED'],
  ];
  for (const [from, event, to] of path) {
    assert.ok(canTransition(LEAD_TRANSITION_TABLE, from, event, to), `${from} --${event}--> ${to}`);
  }
});

test('THRESHOLD_MAP is the only route into QUALIFIED/REVIEW/REJECTED from SCORED', () => {
  const into = LEAD_TRANSITION_TABLE.filter(
    (t) => t.to === 'QUALIFIED' || t.to === 'REJECTED' || t.to === 'REVIEW_REQUIRED',
  );
  for (const t of into) {
    assert.ok(
      t.event === 'THRESHOLD_MAP' || t.event === 'HUMAN_REVIEWED' || t.event === 'ANALYSIS_FAILED',
      `unexpected route into ${t.to} via ${t.event}`,
    );
  }
});

test('AI failure can go to REVIEW_REQUIRED; retry exhaustion goes to FAILED', () => {
  assert.ok(canTransition(LEAD_TRANSITION_TABLE, 'ANALYZING', 'ANALYSIS_FAILED', 'REVIEW_REQUIRED'));
  assert.ok(canTransition(LEAD_TRANSITION_TABLE, 'ANALYZING', 'RETRY_EXHAUSTED', 'FAILED'));
});

test('reprocessing returns terminal/review states to ANALYSIS_PENDING', () => {
  for (const from of ['SCORED', 'REVIEW_REQUIRED', 'REJECTED', 'QUALIFIED', 'FAILED'] as const) {
    assert.ok(canTransition(LEAD_TRANSITION_TABLE, from, 'REPROCESS', 'ANALYSIS_PENDING'), from);
  }
});

test('no transition table entry has an invalid stage pair (sanity)', () => {
  const stages = new Set(LEAD_TRANSITION_TABLE.flatMap((t) => [t.from, t.to]));
  for (const s of stages) assert.ok(typeof s === 'string' && s.length > 0);
  // every state reachable in the table is declared as a `from` or `to`
  assert.ok(stages.has('DISCOVERED') && stages.has('ARCHIVED'));
});

test('failure policy: connector errors retry, data unavailability skips, invalid data is terminal', () => {
  assert.equal(FAILURE_POLICY.CONNECTOR_ERROR.action, 'RETRY');
  assert.equal(FAILURE_POLICY.RATE_LIMITED.maxAttempts, 3);
  assert.equal(FAILURE_POLICY.DATA_UNAVAILABLE.action, 'SKIP');
  assert.equal(FAILURE_POLICY.INVALID_DATA.action, 'TERMINAL_FAIL');
  assert.equal(FAILURE_POLICY.AI_UNAVAILABLE.action, 'REVIEW');
  assert.equal(FAILURE_POLICY.AI_PROVIDER_ERROR.action, 'FALLBACK');
});
