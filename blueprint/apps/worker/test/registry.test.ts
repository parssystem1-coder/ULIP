import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildConnectorRegistry, resolveDiscoveryErrorCode } from '../src/main.ts';
import { ConfiguredHttpApiConnectorFactory, ConnectorRegistry, DiscoveryInputError, ConnectorNotAvailableError, InstagramConnectorError, InstagramGraphConnectorFactory } from '@ulip/discovery';

const T1 = '11111111-1111-1111-1111-111111111111';
const SRC = 'aaaaaaaa-0000-0000-0000-000000000001';

test('worker registry exposes production boundary + fake (for E2E only)', () => {
  const registry: ConnectorRegistry = buildConnectorRegistry();
  assert.deepEqual(registry.registeredTypes(), ['FAKE', 'HTTP_API', 'INSTAGRAM']);

  // INSTAGRAM without credentials ⇒ NOT_CONFIGURED (never pretend support).
  const r = registry.resolveFor({ id: SRC, tenantId: T1, type: 'INSTAGRAM', name: 'x', status: 'ACTIVE', config: {} });
  assert.equal(r.status, 'NOT_CONFIGURED');

  // FAKE only resolves when explicitly allowed (deterministic E2E).
  const fakeSrc = { id: SRC, tenantId: T1, type: 'FAKE', name: 'x', status: 'ACTIVE', config: {} };
  assert.equal(registry.resolveFor(fakeSrc).status, 'UNSUPPORTED');
  assert.equal(registry.resolveFor(fakeSrc, { allowDeterministicFakes: true }).status, 'RESOLVED');
});

test('configured boundary validates https + token without any network call', () => {
  const f = new ConfiguredHttpApiConnectorFactory('HTTP_API');
  assert.equal(f.canBuild({}).ok, false);
  assert.equal(f.canBuild({ provider: 'ig' }).ok, false);
  assert.equal(f.canBuild({ provider: 'ig', apiBaseUrl: 'http://insecure.test' }).ok, false);
  assert.equal(f.canBuild({ provider: 'ig', apiBaseUrl: 'https://ok.test', apiToken: 't' }).ok, true);
});

test('Phase 19: INSTAGRAM factory validates instagram-graph config without network', () => {
  const f = new InstagramGraphConnectorFactory();
  assert.equal(f.canBuild({}).ok, false);
  assert.equal(f.canBuild({ provider: 'instagram-graph' }).ok, false); // no token
  assert.equal(
    f.canBuild({ provider: 'instagram-graph', accessToken: 't', igUserId: '17841405309211844' }).ok,
    true,
  );
  assert.equal(
    f.canBuild({ provider: 'instagram-graph', accessToken: 't', igUserId: '17841405309211844', graphBaseUrl: 'http://insecure.test' }).ok,
    false,
  );
});

// ------------------------------------------------- Phase 21 rate-limit mapping

test('rate-limit paths are TYPED: 429 ± Retry-After and hashtag-budget exhaustion map to RATE_LIMITED', async () => {
  // Provider 429 with Retry-After → RATE_LIMITED, retryable with Retry-After floor.
  const providerErr = new InstagramConnectorError('rate_limited', 'Application request limit reached', {
    httpStatus: 429,
    graphCode: 4,
    retryAfterSeconds: 123,
  });
  const m1 = resolveDiscoveryErrorCode(providerErr);
  assert.equal(m1.code, 'RATE_LIMITED');
  assert.equal(m1.retryable, true);
  assert.equal(m1.retryAfterSeconds, 123, 'provider Retry-After must be preserved verbatim');

  // Provider 429 WITHOUT Retry-After → RATE_LIMITED retryable, no floor override.
  const m2 = resolveDiscoveryErrorCode(
    new InstagramConnectorError('rate_limited', 'limit reached', { httpStatus: 429 }),
  );
  assert.equal(m2.code, 'RATE_LIMITED');
  assert.equal(m2.retryable, true);
  assert.equal(m2.retryAfterSeconds, undefined);

  // Hashtag budget exhausted (7-day rolling window) → RATE_LIMITED with a 7d floor.
  const budgetErr = new ConnectorNotAvailableError(
    'NOT_CONFIGURED',
    'HASHTAG_BUDGET_EXHAUSTED — official rolling-7d quota (30 unique tags/7d) fully used for this source',
  );
  const m3 = resolveDiscoveryErrorCode(budgetErr);
  assert.equal(m3.code, 'RATE_LIMITED');
  assert.equal(m3.retryable, true);
  assert.equal(m3.retryAfterSeconds, 7 * 24 * 3600, 'budget exhaustion re-arms after the 7d window, never sooner');

  // Honest refusals stay non-retryable with their own codes.
  assert.deepEqual(resolveDiscoveryErrorCode(new DiscoveryInputError('bad payload')), { code: 'BAD_REQUEST', retryable: false });
  assert.deepEqual(
    resolveDiscoveryErrorCode(new ConnectorNotAvailableError('UNSUPPORTED', 'no profile_search')),
    { code: 'NOT_CONFIGURED', retryable: false },
  );
  assert.equal(resolveDiscoveryErrorCode(new Error('boom')).code, 'WORKER_ERROR');
});
