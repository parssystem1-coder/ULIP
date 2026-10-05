import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ActionExecutionOutcome } from '../src/contracts.ts';
import {
  ACTION_TRANSITION_TABLE,
  canTransitionAction,
  SocialActionService,
  IdempotencyConflictError,
  InvalidActionInputError,
  InvalidTransitionError,
  ActionNotFoundError,
  FakeActionProvider,
  FixedClock,
  InMemoryAttemptStore,
  InMemoryAuditSink,
  InMemoryContactHistoryStore,
  InMemorySocialActionStore,
  InMemorySuppressionChecker,
  SequentialIdGenerator,
} from '../src/index.ts';

interface Harness {
  provider: FakeActionProvider;
  service: SocialActionService;
  store: InMemorySocialActionStore;
  attempts: InMemoryAttemptStore;
  history: InMemoryContactHistoryStore;
  suppression: InMemorySuppressionChecker;
  audit: InMemoryAuditSink;
  clock: FixedClock;
}

function buildHarness(capabilities: readonly string[]): Harness {
  const provider = new FakeActionProvider({
    sourceType: 'instagram',
    displayName: 'Instagram',
    capabilities: capabilities as never[],
  });
  const store = new InMemorySocialActionStore();
  const attempts = new InMemoryAttemptStore();
  const history = new InMemoryContactHistoryStore();
  const suppression = new InMemorySuppressionChecker();
  const audit = new InMemoryAuditSink();
  const clock = new FixedClock();
  const service = new SocialActionService({
    providers: new Map([['instagram', provider]]),
    store,
    attempts,
    contactHistory: history,
    suppression,
    audit,
    clock,
    ids: new SequentialIdGenerator(),
  });
  return { provider, service, store, attempts, history, suppression, audit, clock };
}

const BASE_INPUT = {
  tenantId: 'tenant-1',
  actorId: 'user-1',
  leadId: 'lead-1',
  sourceType: 'instagram',
  target: { leadId: 'lead-1', externalId: 'ig-123', profileUrl: 'https://instagram.com/lead1' },
  idempotencyKey: 'key-1',
} as const;

test('capability report is honest: unconfigured provider reports nothing supported', () => {
  const { service } = buildHarness([]);
  const report = service.capabilityReport('instagram');
  for (const value of Object.values(report)) {
    assert.equal(value, 'NOT_SUPPORTED');
  }
});

test('capability report marks only genuinely advertised capabilities', () => {
  const { service } = buildHarness(['FOLLOW_PROFILE', 'UNFOLLOW_PROFILE']);
  const report = service.capabilityReport('instagram');
  assert.equal(report.FOLLOW_PROFILE, 'SUPPORTED');
  assert.equal(report.UNFOLLOW_PROFILE, 'SUPPORTED');
  assert.equal(report.OPEN_PROFILE, 'NOT_SUPPORTED');
  assert.equal(report.SEND_MESSAGE, 'NOT_SUPPORTED');
});

test('unsupported provider action: NOT_SUPPORTED, no provider call, manual fallback plan', async () => {
  const h = buildHarness([]);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  assert.equal(result.kind, 'NOT_SUPPORTED');
  assert.equal(h.provider.calls.length, 0);
  assert.equal(result.kind === 'NOT_SUPPORTED' && result.action.status, 'NOT_SUPPORTED');
  if (result.kind === 'NOT_SUPPORTED') {
    assert.equal(result.fallback.reason, 'ACTION_CAPABILITY_NOT_SUPPORTED');
    assert.equal(result.fallback.targetProfileUrl, BASE_INPUT.target.profileUrl);
    assert.ok(result.fallback.instructions.length >= 3);
    assert.ok(result.fallback.instructions.join(' ').includes('manually'));
  }
  const attempts = await h.service.listAttempts('tenant-1', result.action.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.outcome, 'NOT_SUPPORTED');
});

test('follow executes through provider and records audit + contact history', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  assert.equal(result.kind, 'EXECUTED');
  if (result.kind !== 'EXECUTED') return;
  assert.equal(result.provider.status, 'SUCCEEDED');
  assert.equal(result.action.status, 'SUCCEEDED');
  assert.equal(h.provider.calls.length, 1);
  assert.equal(h.provider.calls[0]?.operation, 'FOLLOW_PROFILE');
  assert.ok(h.audit.entries.length >= 3); // CREATED, EXECUTE, SUCCEED
  assert.equal(h.history.rows.length, 1);
  assert.equal(h.history.rows[0]?.channel, 'FOLLOW');
});

test('unfollow executes and unfollow capability is independent from follow', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const refused = await h.service.execute({ ...BASE_INPUT, type: 'UNFOLLOW_PROFILE', idempotencyKey: 'k-u0' });
  assert.equal(refused.kind, 'NOT_SUPPORTED');

  const h2 = buildHarness(['UNFOLLOW_PROFILE']);
  const result = await h2.service.execute({ ...BASE_INPUT, type: 'UNFOLLOW_PROFILE' });
  assert.equal(result.kind, 'EXECUTED');
  assert.equal(h2.provider.calls[0]?.operation, 'UNFOLLOW_PROFILE');
});

test('idempotency: same key replays the original record without a second provider call', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const first = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  const replay = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  assert.equal(first.kind, 'EXECUTED');
  assert.equal(replay.kind, 'IDEMPOTENT_REPLAY');
  assert.equal(h.provider.calls.length, 1);
  if (replay.kind === 'IDEMPOTENT_REPLAY' && first.kind === 'EXECUTED') {
    assert.equal(replay.action.id, first.action.id);
    assert.equal(replay.action.status, 'SUCCEEDED');
  }
});

test('idempotency: same key with a different action is a conflict', async () => {
  const h = buildHarness(['FOLLOW_PROFILE', 'UNFOLLOW_PROFILE']);
  await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  await assert.rejects(
    h.service.execute({ ...BASE_INPUT, type: 'UNFOLLOW_PROFILE' }),
    IdempotencyConflictError,
  );
});

test('SEND_MESSAGE without a rendered message is rejected before anything happens', async () => {
  const h = buildHarness(['SEND_MESSAGE']);
  await assert.rejects(
    h.service.execute({ ...BASE_INPUT, type: 'SEND_MESSAGE' }),
    InvalidActionInputError,
  );
  assert.equal(h.provider.calls.length, 0);
});

test('suppressed lead: action blocked, provider never called, attempt recorded', async () => {
  const h = buildHarness(['SEND_MESSAGE']);
  h.suppression.suppress('tenant-1', 'lead-1', { scope: 'LEAD', reason: 'MANUAL' });
  const result = await h.service.execute({
    ...BASE_INPUT,
    type: 'SEND_MESSAGE',
    message: 'hello',
  });
  assert.equal(result.kind, 'BLOCKED_SUPPRESSED');
  assert.equal(h.provider.calls.length, 0);
  if (result.kind === 'BLOCKED_SUPPRESSED') {
    assert.equal(result.action.status, 'CANCELLED');
    assert.equal(result.action.errorCode, 'SUPPRESSED');
  }
  const attempts = await h.service.listAttempts('tenant-1', result.action.id);
  assert.equal(attempts[0]?.outcome, 'FATAL_FAILURE');
});

test('recent contact within the cool-down window blocks a duplicate message', async () => {
  const h = buildHarness(['SEND_MESSAGE']);
  const first = await h.service.execute({
    ...BASE_INPUT,
    type: 'SEND_MESSAGE',
    message: 'first',
    idempotencyKey: 'msg-1',
  });
  assert.equal(first.kind, 'EXECUTED');

  h.clock.advanceHours(2); // window default 24h
  const second = await h.service.execute({
    ...BASE_INPUT,
    type: 'SEND_MESSAGE',
    message: 'second',
    idempotencyKey: 'msg-2',
  });
  assert.equal(second.kind, 'BLOCKED_RECENT_CONTACT');
  assert.equal(h.provider.calls.length, 1); // only the first message reached the provider

  h.clock.advanceHours(23); // beyond the 24h window
  const third = await h.service.execute({
    ...BASE_INPUT,
    type: 'SEND_MESSAGE',
    message: 'third',
    idempotencyKey: 'msg-3',
  });
  assert.equal(third.kind, 'EXECUTED');
  assert.equal(h.provider.calls.length, 2);
});

test('tenant isolation: records are scoped by tenant and never leak', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  if (result.kind !== 'EXECUTED') return assert.fail('expected execution');

  await assert.rejects(
    h.service.getAction('tenant-2', result.action.id),
    ActionNotFoundError,
  );
  // Cross-tenant lookups via the raw store also return nothing.
  assert.equal(await h.store.findById('tenant-2', result.action.id), null);
  assert.equal(await h.store.findByIdempotencyKey('tenant-2', 'key-1'), null);
});

test('provider rate limit is respected: FAILED + retryAfter persisted on the attempt', async () => {
  const rateLimited: ActionExecutionOutcome = {
    status: 'FAILED',
    errorCode: 'RATE_LIMITED',
    errorMessage: 'slow down',
    retryAfterAt: '2026-10-05T01:00:00.000Z',
  };
  const h = buildHarness(['SEND_MESSAGE']);
  h.provider.setScript([rateLimited]);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'SEND_MESSAGE', message: 'hi' });
  assert.equal(result.kind, 'EXECUTED');
  if (result.kind !== 'EXECUTED') return;
  assert.equal(result.provider.status, 'FAILED');
  assert.equal(result.action.status, 'FAILED');
  const attempts = await h.service.listAttempts('tenant-1', result.action.id);
  assert.equal(attempts[0]?.outcome, 'RETRYABLE_FAILURE');
  assert.equal(attempts[0]?.retryAfterAt, rateLimited.retryAfterAt);

  // Retry after the provider clears the limit → succeeds with the same key.
  h.clock.advanceHours(2);
  h.provider.setScript([{ status: 'SUCCEEDED', providerRef: 'ref-retry' }]);
  const retried = await h.service.retry('tenant-1', result.action.id, 'user-1');
  assert.equal(retried.kind, 'EXECUTED');
  if (retried.kind === 'EXECUTED') assert.equal(retried.action.status, 'SUCCEEDED');
});

test('provider refusing mid-flight (NOT_SUPPORTED) transitions honestly to NOT_SUPPORTED', async () => {
  const h = buildHarness(['SEND_MESSAGE']);
  h.provider.setScript([{ status: 'NOT_SUPPORTED', errorCode: 'PROVIDER_ERROR', errorMessage: 'dm api unavailable' }]);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'SEND_MESSAGE', message: 'hi' });
  assert.equal(result.kind, 'NOT_SUPPORTED');
  if (result.kind !== 'NOT_SUPPORTED') return;
  assert.equal(result.action.status, 'NOT_SUPPORTED');
  assert.equal(result.fallback.actionType, 'SEND_MESSAGE');
  assert.equal(result.fallback.preparedMessage, 'hi');
});

test('manual fallback loop: NOT_SUPPORTED → fallback plan → COMPLETE_MANUAL → SUCCEEDED', async () => {
  const h = buildHarness([]);
  const refused = await h.service.execute({ ...BASE_INPUT, type: 'SEND_MESSAGE', message: 'manual msg' });
  assert.equal(refused.kind, 'NOT_SUPPORTED');
  if (refused.kind !== 'NOT_SUPPORTED') return;
  assert.equal(refused.fallback.preparedMessage, 'manual msg');

  const started = await h.service.startManualFallback('tenant-1', refused.action.id, 'user-1');
  assert.equal(started.status, 'MANUAL_FALLBACK');

  const done = await h.service.completeManually('tenant-1', refused.action.id, 'user-1');
  assert.equal(done.kind, 'COMPLETED_MANUALLY');
  if (done.kind === 'COMPLETED_MANUALLY') {
    assert.equal(done.action.status, 'SUCCEEDED');
    assert.ok(done.action.manualCompletedAt !== undefined);
  }
  assert.equal(h.history.rows[0]?.direction, 'MANUAL');
});

test('action state transition table: declared edges only, and canonical paths work', () => {
  // canonical happy path
  assert.ok(canTransitionAction('PENDING', 'EXECUTE', 'EXECUTING'));
  assert.ok(canTransitionAction('EXECUTING', 'SUCCEED', 'SUCCEEDED'));
  // implicit edges are forbidden
  assert.equal(canTransitionAction('PENDING', 'SUCCEED', 'SUCCEEDED'), false);
  assert.equal(canTransitionAction('SUCCEEDED', 'RETRY', 'PENDING'), false);
  assert.equal(canTransitionAction('CANCELLED', 'EXECUTE', 'EXECUTING'), false);
  // every declared edge is unique
  const seen = new Set<string>();
  for (const t of ACTION_TRANSITION_TABLE) {
    const key = `${t.from}|${t.event}|${t.to}`;
    assert.equal(seen.has(key), false, `duplicate transition ${key}`);
    seen.add(key);
  }
});

test('invalid transitions throw InvalidTransitionError', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const result = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE' });
  if (result.kind !== 'EXECUTED') return assert.fail('expected execution');
  await assert.rejects(h.service.cancel('tenant-1', result.action.id, 'user-1'), InvalidTransitionError);
});

test('approval flow routes PENDING → AWAITING_APPROVAL and rejects execution until approved', async () => {
  const h = buildHarness(['FOLLOW_PROFILE']);
  const held = await h.service.execute({ ...BASE_INPUT, type: 'FOLLOW_PROFILE', requireApproval: true });
  assert.equal(held.kind, 'AWAITING_APPROVAL');
  assert.equal(h.provider.calls.length, 0);

  const approved = await h.service.approve('tenant-1', held.action.id, 'admin-1');
  assert.equal(approved.status, 'APPROVED');
  assert.equal(h.provider.calls.length, 0); // approve only records; execution is explicit
});
