import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ConnectorNotAvailableError,
  ConfiguredHttpApiConnectorFactory,
  ConnectorRegistry,
  DiscoveryInputError,
  PersianAwareNormalizer,
  DeterministicFakeConnectorFactory,
} from '../src/index.ts';
import { FakeRawEntityStore, FakeResolver, FakeSources, flowSource, makeSource, runTestDiscovery } from './fakes.ts';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const SRC1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const SRC2 = 'aaaaaaaa-0000-0000-0000-000000000002';

test('normalizer: deterministic Persian name keys + hints (universal business model)', () => {
  const n = new PersianAwareNormalizer();
  const a = n.normalize({
    sourceType: 'FAKE',
    externalId: 'x1',
    entityType: 'BUSINESS_PROFILE',
    payload: {
      username: 'chap_tehran',
      full_name: 'چاپخانه تهران',
      biography: 'عمده‌فروش قطعات پرینتر HP',
      category: 'WHOLESALE',
      city: 'تهران',
      brand: 'HP',
    },
  });
  // Same input ⇒ same key (deterministic).
  const b = n.normalize({
    sourceType: 'FAKE',
    externalId: 'x1',
    entityType: 'BUSINESS_PROFILE',
    payload: {
      username: 'chap_tehran',
      full_name: 'چاپخانه تهران',
      biography: 'عمده‌فروش قطعات پرینتر HP',
      category: 'WHOLESALE',
      city: 'تهران',
      brand: 'HP',
    },
  });
  assert.equal(a.nameKey, b.nameKey);
  assert.equal(a.displayName, 'چاپخانه تهران');
  assert.equal(a.username, 'chap_tehran');
  assert.equal(a.hints['businessType'], 'Wholesaler');
  assert.equal(a.hints['brand'], 'HP');
  assert.equal(a.hints['location'], 'تهران');
  assert.equal(a.hints['specialty'], 'Printer Parts');
});

test('connector registry: FAKE refused outside explicit fake mode (honest gate)', () => {
  const registry = new ConnectorRegistry();
  registry.register(new DeterministicFakeConnectorFactory());
  const src = makeSource(SRC1, T1, 'FAKE');
  const refused = registry.resolveFor(src, { allowDeterministicFakes: false });
  assert.equal(refused.status, 'UNSUPPORTED');
  const allowed = registry.resolveFor(src, { allowDeterministicFakes: true });
  assert.equal(allowed.status, 'RESOLVED');
  assert.equal(allowed.isDeterministicFake, true);
});

test('connector registry: configured production type without credentials ⇒ NOT_CONFIGURED', () => {
  const registry = new ConnectorRegistry();
  registry.register(new ConfiguredHttpApiConnectorFactory('INSTAGRAM'));
  const unconfigured = registry.resolveFor(makeSource(SRC1, T1, 'INSTAGRAM', {}));
  assert.equal(unconfigured.status, 'NOT_CONFIGURED');
  assert.match(unconfigured.reason ?? '', /provider is required/);

  // Fully configured boundary resolves, but advertises NO discovery capability
  // until the authorized provider adapter is actually implemented.
  const configured = registry.resolveFor(
    makeSource(SRC2, T1, 'INSTAGRAM', { provider: 'instagram-graph', apiBaseUrl: 'https://graph.example.test/v1', apiToken: 'tok_abc' }),
  );
  assert.equal(configured.status, 'RESOLVED');
  assert.equal(configured.connector?.supports('profile_search'), false);
  assert.equal(configured.isDeterministicFake ?? false, false);
});

test('unknown source type ⇒ UNKNOWN_SOURCE_TYPE', () => {
  const registry = new ConnectorRegistry();
  registry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  const r = registry.resolveFor(makeSource(SRC1, T1, 'SOMETHING_ELSE', {}));
  assert.equal(r.status, 'UNKNOWN_SOURCE_TYPE');
});

test('payload parsing: bad shapes rejected deterministically', async () => {
  const { parseDiscoveryPayload } = await import('../src/index.ts');
  assert.throws(() => parseDiscoveryPayload(null), DiscoveryInputError);
  assert.throws(() => parseDiscoveryPayload({}), DiscoveryInputError);
  assert.throws(() => parseDiscoveryPayload({ sourceId: 42 }), DiscoveryInputError);
  assert.throws(() => parseDiscoveryPayload({ sourceId: 's', filters: { k: 5 } }), DiscoveryInputError);
  assert.throws(() => parseDiscoveryPayload({ sourceId: 's', maxCandidates: 0 }), DiscoveryInputError);
  const ok = parseDiscoveryPayload({ sourceId: 's', query: 'q', maxCandidates: 10 });
  assert.deepEqual(ok, { sourceId: 's', query: 'q', filters: {}, maxCandidates: 10, cursor: undefined });
});

test('discovery flow: tenant isolation — source of another tenant is invisible', async () => {
  const store = new FakeRawEntityStore();
  const resolver = new FakeResolver();
  await assert.rejects(
    () => runTestDiscovery({ sources: new FakeSources([flowSource(SRC1, T1)]), rawEntities: store, resolver }, { sourceId: SRC1 }, { tenantId: T2 }),
    (err: Error) => err.name === 'DiscoveryInputError',
  );
  assert.equal(store.rows.length, 0);
  assert.equal(resolver.leads.length, 0);
});

test('discovery flow E2E (fake provider): raw → normalize → resolve → leads, idempotent on repeat', async () => {
  const store = new FakeRawEntityStore();
  const resolver = new FakeResolver();
  const sources = new FakeSources([flowSource(SRC1, T1)]);

  const first = await runTestDiscovery({ sources, rawEntities: store, resolver }, { sourceId: SRC1, query: 'چاپخانه', maxCandidates: 10 }, { tenantId: T1 });
  assert.ok(first.discovered >= 1);
  assert.equal(first.created, first.discovered);
  assert.equal(first.rawPersisted, first.discovered);

  const second = await runTestDiscovery({ sources, rawEntities: store, resolver }, { sourceId: SRC1, query: 'چاپخانه', maxCandidates: 10 }, { tenantId: T1 });
  assert.equal(second.discovered, first.discovered);
  // Raw snapshots unchanged (same hash) and no NEW leads: dedup by identity key.
  assert.equal(second.rawPersisted, 0);
  assert.equal(second.created, 0);
  assert.equal(second.updated, second.discovered);
  assert.equal(resolver.leads.length, first.discovered);
  assert.equal(store.rows.length, first.discovered);
});

test('discovery flow: connector failure is surfaced, no partial lead rows', async () => {
  const { runDiscovery, PersianAwareNormalizer } = await import('../src/index.ts');
  const registry = new ConnectorRegistry();
  registry.register(new ConfiguredHttpApiConnectorFactory('HTTP_API'));
  const store = new FakeRawEntityStore();
  const resolver = new FakeResolver();
  const src = makeSource(SRC1, T1, 'HTTP_API', { provider: 'p', apiBaseUrl: 'https://api.example.test', apiToken: 't' });
  await assert.rejects(
    () =>
      runDiscovery(
        {
          log: { info: () => undefined, error: () => undefined },
          sources: new FakeSources([src]),
          rawEntities: store,
          normalizer: new PersianAwareNormalizer(),
          resolver,
          connectorRegistry: registry,
        },
        { sourceId: SRC1 },
        { tenantId: T1 },
      ),
    (err: Error) => err.name === 'ConnectorNotAvailableError',
  );
  assert.equal(store.rows.length, 0);
});

test('ConnectorNotAvailableError carries the honest status', () => {
  const e = new ConnectorNotAvailableError('NOT_CONFIGURED', 'missing token');
  assert.equal(e.resolutionStatus, 'NOT_CONFIGURED');
  assert.match(e.message, /NOT_CONFIGURED/);
});
