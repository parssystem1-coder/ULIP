import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildConnectorRegistry } from '../src/main.ts';
import { ConfiguredHttpApiConnectorFactory, ConnectorRegistry } from '@ulip/discovery';

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
  const f = new ConfiguredHttpApiConnectorFactory('INSTAGRAM');
  assert.equal(f.canBuild({}).ok, false);
  assert.equal(f.canBuild({ provider: 'ig' }).ok, false);
  assert.equal(f.canBuild({ provider: 'ig', apiBaseUrl: 'http://insecure.test' }).ok, false);
  assert.equal(f.canBuild({ provider: 'ig', apiBaseUrl: 'https://ok.test', apiToken: 't' }).ok, true);
});
