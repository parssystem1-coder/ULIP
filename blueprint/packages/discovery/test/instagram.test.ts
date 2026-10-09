/**
 * Phase 19 tests: the REAL authorized Instagram Graph connector, exercised
 * against a deterministic in-process fake Graph server (no network, no
 * credentials). Honest-behavior assertions included: capability advertisement,
 * quota refusal BEFORE network, typed error mapping, no token leakage,
 * partial-failure semantics, and Phase 18 content-ingestion compatibility.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DiscoveryInputError,
  InstagramConnectorError,
  InstagramGraphConnector,
  InstagramGraphConnectorFactory,
  ConnectorRegistry,
  RollingWindowQuota,
  decodeCursor,
  encodeCursor,
  extractUsernames,
  normalizeHashtag,
  parseInstagramGraphConfig,
  profileUrlFor,
  splitUsernames,
} from '../src/index.ts';
import { extractContentItems } from '../src/content.ts';

// ---------------------------------------------------------------------------
// Deterministic fake Graph server (records every request; no network)
// ---------------------------------------------------------------------------

const TOKEN = 'IGAA-test-token-abc123';
const IG_USER_ID = '17841405309211844';

interface RecordedRequest {
  url: string;
}

type Handler = (url: string) => Response;

/** Adapts a sync fake handler to the connector's async FetchLike. */
function fetchLike(handler: Handler): (url: string) => Promise<Response> {
  return async (url: string) => handler(url);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function graphErrorBody(code: number, message: string): unknown {
  return { error: { message, type: 'OAuthException', code, fbtrace_id: 'fake-trace' } };
}

function media(id: string, owner: string, opts: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    username: owner,
    caption: `post ${id} caption`,
    media_type: 'IMAGE',
    media_url: `https://scontent.example.test/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
    timestamp: '2026-09-20T10:00:00+0000',
    like_count: 101,
    comments_count: 7,
    ...opts,
  };
}

const BLUEBOTTLE_BD = {
  id: '17841401441775531',
  username: 'bluebottle',
  name: 'Blue Bottle Coffee',
  biography: 'Coffee wholesale & cafes — HP of beans', // brand-style hint text for normalizer checks elsewhere
  website: 'https://bluebottle.example.test',
  followers_count: 267793,
  follows_count: 42,
  media_count: 1205,
  profile_picture_url: 'https://scontent.example.test/bluebottle.jpg',
  media: {
    data: [
      media('m-bd-1', 'bluebottle', { media_type: 'VIDEO' }),
      media('m-bd-2', 'bluebottle', { media_type: 'CAROUSEL_ALBUM' }),
    ],
  },
};

/** Standard fake: hashtag search + top_media with two owners + BD expansion. */
function standardFakeGraph(opts: { bdFailures?: Iterable<string> } = {}): { handler: Handler; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const bdFailures = new Set(opts.bdFailures ?? []);
  const handler: Handler = (url) => {
    requests.push({ url });
    const u = new URL(url);
    if (u.searchParams.get('access_token') !== TOKEN) {
      return jsonResponse(graphErrorBody(190, 'Invalid access token'), 401);
    }
    const path = u.pathname;
    // .../v25.0/ig_hashtag_search
    if (path.endsWith('/ig_hashtag_search')) {
      assert.equal(u.searchParams.get('user_id'), IG_USER_ID);
      const q = u.searchParams.get('q') ?? '';
      return jsonResponse({ data: [{ id: `tag-${q}` }] });
    }
    // .../{tag-id}/top_media or recent_media
    if (path.endsWith('/top_media') || path.endsWith('/recent_media')) {
      const tagId = path.split('/')[path.split('/').length - 2] ?? '';
      const tag = tagId.replace(/^tag-/, '');
      return jsonResponse({
        data: [
          media('m-h1-1', 'bluebottle'),
          media('m-h1-2', 'bluebottle', { media_type: 'VIDEO' }),
          media('m-h2-1', 'partsha'),
          media('m-h2-2', 'orphaned', { username: undefined }),
        ],
        paging: { cursors: { after: `CUR-${tag}-1` } },
      });
    }
    // .../v25.0/{app-user-id}?fields=business_discovery...
    if (path === `/v25.0/${IG_USER_ID}`) {
      const fields = u.searchParams.get('fields') ?? '';
      const m = /business_discovery\.username\(([a-z0-9_.]+)\)/.exec(fields);
      if (m === null) {
        // health check / plain owned-account query
        return jsonResponse({ id: IG_USER_ID, username: 'our_shop' });
      }
      const target = m[1] ?? '';
      if (bdFailures.has(target)) {
        return jsonResponse(graphErrorBody(803, `Cannot find user ${target}`), 404);
      }
      return jsonResponse({ business_discovery: BLUEBOTTLE_BD === null ? {} : { ...BLUEBOTTLE_BD, username: target, id: `id-${target}` } });
    }
    return jsonResponse(graphErrorBody(100, 'Unsupported request'), 400);
  };
  return { handler, requests };
}

function makeConnector(handler: Handler, overrides: Record<string, unknown> = {}): InstagramGraphConnector {
  const cfg = parseInstagramGraphConfig({
    provider: 'instagram-graph',
    accessToken: TOKEN,
    igUserId: IG_USER_ID,
    graphBaseUrl: 'https://graph.test',
    graphVersion: 'v25.0',
    retryBackoffMs: 0,
    ...overrides,
  });
  assert.ok(cfg.ok, 'test config must parse');
  return new InstagramGraphConnector(cfg.config, fetchLike(handler));
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'instagram-graph',
    accessToken: TOKEN,
    igUserId: IG_USER_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config validation (factory canBuild — no network)
// ---------------------------------------------------------------------------

test('instagram config: required fields + validation without network', () => {
  assert.equal(parseInstagramGraphConfig({}).ok, false);
  assert.equal(parseInstagramGraphConfig({ provider: 'other' }).ok, false);
  assert.equal(parseInstagramGraphConfig({ provider: 'instagram-graph' }).ok, false); // no token
  assert.equal(parseInstagramGraphConfig(validConfig({ igUserId: '' })).ok, false);
  assert.equal(parseInstagramGraphConfig(validConfig({ igUserId: 'not-numeric' })).ok, false);
  assert.equal(parseInstagramGraphConfig(validConfig({ graphBaseUrl: 'http://insecure.test' })).ok, false);
  assert.equal(parseInstagramGraphConfig(validConfig({ graphVersion: '25.0' })).ok, false);
  assert.equal(parseInstagramGraphConfig(validConfig({ discoveryMode: 'crawl' })).ok, false);
  assert.equal(parseInstagramGraphConfig(validConfig({ mediaEdge: 'both' })).ok, false);

  const ok = parseInstagramGraphConfig(validConfig());
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.config.graphBaseUrl, 'https://graph.facebook.com');
    assert.equal(ok.config.graphVersion, 'v25.0');
    assert.equal(ok.config.discoveryMode, 'hashtag');
    assert.equal(ok.config.pageLimit, 12);
    assert.equal(ok.config.expandProfiles, true);
    assert.equal(ok.config.hashtagBudgetPer7d, 30);
  }
});

test('instagram factory: registry resolution is honest (NOT_CONFIGURED ⇄ RESOLVED)', () => {
  const registry = new ConnectorRegistry();
  registry.register(new InstagramGraphConnectorFactory());
  const src = { id: 's1', tenantId: 't1', type: 'INSTAGRAM', name: 'ig', status: 'ACTIVE', config: {} as Record<string, unknown> };
  const unconfigured = registry.resolveFor(src);
  assert.equal(unconfigured.status, 'NOT_CONFIGURED');
  assert.match(unconfigured.reason ?? '', /provider is required/);

  const missingToken = registry.resolveFor({ ...src, config: { provider: 'instagram-graph' } });
  assert.equal(missingToken.status, 'NOT_CONFIGURED');
  assert.match(missingToken.reason ?? '', /accessToken is required/);

  const resolved = registry.resolveFor({ ...src, config: validConfig() });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.isDeterministicFake ?? false, false);
  assert.equal(resolved.connector?.metadata().type, 'INSTAGRAM');
});

// ---------------------------------------------------------------------------
// Honest capability advertisement
// ---------------------------------------------------------------------------

test('instagram connector advertises only genuinely implemented capabilities', () => {
  const c = makeConnector(() => jsonResponse({}));
  assert.deepEqual([...c.capabilities()].sort(), ['content_fetch', 'engagement_metrics', 'profile_fetch', 'profile_search']);
  assert.equal(c.supports('profile_search'), true);
  assert.equal(c.supports('location'), false); // Graph exposes no address via these surfaces
  assert.equal(c.supports('image_fetch'), false); // binary image retrieval is not the connector's job
  assert.equal(c.metadata().displayName.includes('authorized'), true);

  const summary = c.configSummary();
  assert.equal(summary.hasToken, true);
  assert.ok(!JSON.stringify(summary).includes(TOKEN)); // never leaks the token
});

// ---------------------------------------------------------------------------
// Hashtag search happy path
// ---------------------------------------------------------------------------

test('hashtag search: ig_hashtag_search → top_media → business_discovery expansion', async () => {
  const { handler, requests } = standardFakeGraph({ bdFailures: ['partsha'] });
  const c = makeConnector(handler);
  const result = await c.search({ query: '#PrinterParts', filters: {}, limit: 10 });

  // Request shape: authorized base URL, version, token as query param.
  assert.ok(requests[0]?.url.startsWith('https://graph.test/v25.0/ig_hashtag_search?'));
  assert.ok(requests[0]?.url.includes(`access_token=${encodeURIComponent(TOKEN)}`));
  assert.ok(requests.some((r) => r.url.includes('/top_media')));

  // One entity per distinct media owner.
  assert.equal(result.items.length, 2);
  const byUsername = new Map(result.items.map((i) => [String(i.payload['username']), i]));
  const bb = byUsername.get('bluebottle');
  assert.ok(bb);
  assert.equal(bb.sourceType, 'INSTAGRAM');
  assert.equal(bb.entityType, 'BUSINESS_PROFILE');
  assert.equal(bb.externalId, 'id-bluebottle'); // expanded: Graph ID is the identity
  assert.equal(bb.payload['biography'], BLUEBOTTLE_BD.biography);
  assert.equal(bb.payload['followers_count'], 267793);
  assert.equal(bb.payload['external_url'], 'https://bluebottle.example.test');
  assert.equal(bb.payload['profile_url'], 'https://www.instagram.com/bluebottle/');
  assert.equal(bb.payload['profile_evidence'], 'business_discovery');

  // Content evidence: BD feed first, then the owner's hashtag media.
  const posts = bb.payload['posts'] as Record<string, unknown>[];
  assert.equal(posts.length, 4); // 2 BD feed + 2 owner hashtag media (deduped by id)
  assert.equal(posts[0]?.['id'], 'm-bd-1');
  assert.equal(posts[0]?.['published_at'], '2026-09-20T10:00:00+0000');
  assert.equal(posts[0]?.['likes'], 101);
  assert.equal(posts[0]?.['comments'], 7);
  assert.equal(posts[0]?.['media_type'], 'VIDEO'); // verbatim — no fabricated REEL type
  assert.equal(posts[1]?.['media_type'], 'CAROUSEL_ALBUM'); // verbatim

  // Expansion failure → media-only entity + honest partiality.
  const partsha = byUsername.get('partsha');
  assert.ok(partsha);
  assert.equal(partsha.externalId, 'partsha');
  assert.equal(partsha.payload['profile_evidence'], 'hashtag_media_only');

  assert.equal(result.partial, true);
  assert.ok(result.warnings.some((w) => w.includes('m-h2-2'))); // ownerless media warned by id
  assert.ok(result.warnings.some((w) => w.includes('partsha'))); // bd failure warned
});

test('hashtag search: Phase 18 content extractor consumes connector payloads', async () => {
  const { handler } = standardFakeGraph();
  const c = makeConnector(handler);
  const result = await c.search({ query: 'printerparts', filters: {}, limit: 10 });
  const bb = result.items.find((i) => i.payload['username'] === 'bluebottle');
  assert.ok(bb);
  const items = extractContentItems(bb.payload);
  assert.ok(items.length >= 3);
  const carousel = items.find((i) => i.sourceContentId === 'm-bd-2');
  assert.ok(carousel);
  assert.equal(carousel.contentType, 'CAROUSEL'); // Graph CAROUSEL_ALBUM → canonical
  const video = items.find((i) => i.sourceContentId === 'm-bd-1');
  assert.ok(video);
  assert.equal(video.contentType, 'VIDEO');
  assert.equal(video.metadata['likes'], 101);
  assert.equal(video.metadata['comments'], 7);
  // The Phase 18 extractor normalizes Graph timestamps to strict ISO.
  assert.equal(video.publishedAt, '2026-09-20T10:00:00.000Z');
  const hashtagOnly = items.find((i) => i.sourceContentId === 'm-h1-1');
  assert.ok(hashtagOnly);
  assert.equal(hashtagOnly.contentType, 'IMAGE');
});

test('hashtag search: mediaEdge filter selects recent vs top', async () => {
  const { handler, requests } = standardFakeGraph();
  const c = makeConnector(handler);
  await c.search({ query: 'printerparts', filters: { mediaEdge: 'recent' }, limit: 10 });
  assert.ok(requests.some((r) => r.url.includes('/recent_media')));
  assert.ok(!requests.some((r) => r.url.includes('/top_media')));
});

test('hashtag search: expandProfiles=false skips business discovery, identity falls back to username', async () => {
  const { handler, requests } = standardFakeGraph();
  const c = makeConnector(handler);
  const result = await c.search({ query: 'printerparts', filters: { expandProfiles: 'false' }, limit: 10 });
  assert.ok(!requests.some((r) => r.url.includes('business_discovery')));
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.payload['profile_evidence'], 'hashtag_media_only');
    assert.equal(item.externalId, item.payload['username']);
  }
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('hashtag search: cursor pagination round-trips through nextCursor', async () => {
  const { handler, requests } = standardFakeGraph();
  const c = makeConnector(handler);
  const first = await c.search({ query: 'printerparts', filters: {}, limit: 10 });
  assert.ok(first.nextCursor !== undefined);

  const decoded = decodeCursor(first.nextCursor as string);
  assert.equal(decoded.t, 'ig-hashtag');
  if (decoded.t === 'ig-hashtag') {
    assert.equal(decoded.tag, 'printerparts');
    assert.equal(decoded.edge, 'top');
    assert.equal(decoded.after, 'CUR-printerparts-1');
  }

  const second = await c.search({ query: 'printerparts', filters: {}, limit: 10, cursor: first.nextCursor as string });
  assert.ok(requests.some((r) => r.url.includes('after=CUR-printerparts-1')));
  assert.equal(second.items.length, 2);
});

test('cursor codec: strict validation rejects garbage and mismatches', () => {
  assert.throws(() => decodeCursor('not-a-cursor'), DiscoveryInputError);
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify({ t: 'unknown' })).toString('base64url')), DiscoveryInputError);
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify({ t: 'ig-hashtag', tag: 'x' })).toString('base64url')),
    DiscoveryInputError,
  );
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify({ t: 'ig-usernames', remaining: [42] })).toString('base64url')),
    DiscoveryInputError,
  );
  const round = encodeCursor({ t: 'ig-usernames', remaining: ['a', 'b'] });
  const decoded = decodeCursor(round);
  assert.deepEqual(decoded, { t: 'ig-usernames', remaining: ['a', 'b'] });
});

test('search: empty query and wrong-mode cursors are rejected deterministically', async () => {
  const { handler } = standardFakeGraph();
  const c = makeConnector(handler);
  await assert.rejects(() => c.search({ filters: {}, limit: 10 }), DiscoveryInputError);
  await assert.rejects(
    () => c.search({ query: 'printerparts', filters: {}, limit: 10, cursor: encodeCursor({ t: 'ig-usernames', remaining: ['x'] }) }),
    DiscoveryInputError,
  );
});

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

test('hashtag quota: refusal happens BEFORE any network call; repeats stay free', async () => {
  const { handler, requests } = standardFakeGraph();
  const c = makeConnector(handler, { hashtagBudgetPer7d: 2 });
  await c.search({ query: 'tag1', filters: {}, limit: 5 });
  await c.search({ query: '#tag1', filters: {}, limit: 5 }); // repeat: free
  await c.search({ query: 'tag2', filters: {}, limit: 5 });
  const countAfterTwo = requests.length;
  await assert.rejects(
    () => c.search({ query: 'tag3', filters: {}, limit: 5 }),
    (err: unknown) => err instanceof InstagramConnectorError && err.kind === 'rate_limited',
  );
  assert.equal(requests.length, countAfterTwo); // nothing hit the network
});

test('RollingWindowQuota: unique keys consume budget, repeats do not, window prunes', () => {
  let now = 1_000_000;
  const q = new RollingWindowQuota(() => now);
  assert.equal(q.tryAcquire('a', 2), true);
  assert.equal(q.tryAcquire('b', 2), true);
  assert.equal(q.tryAcquire('a', 2), true); // repeat: free
  assert.equal(q.tryAcquire('c', 2), false); // over budget
  now += 7 * 24 * 60 * 60 * 1000; // window fully elapsed
  assert.equal(q.uniqueCount(), 0);
  assert.equal(q.tryAcquire('c', 2), true);
});

// ---------------------------------------------------------------------------
// Error mapping + retry semantics + token hygiene
// ---------------------------------------------------------------------------

test('error mapping: typed kinds for auth/permission/not_found/invalid_request', async () => {
  const cases: { code: number; kind: InstagramConnectorError['kind'] }[] = [
    { code: 190, kind: 'auth' },
    { code: 10, kind: 'permission' },
    { code: 200, kind: 'permission' },
    { code: 100, kind: 'invalid_request' },
  ];
  for (const { code, kind } of cases) {
    const c = makeConnector(() => jsonResponse(graphErrorBody(code, `boom ${code}`), 400), { maxAttempts: 1 });
    await assert.rejects(
      () => c.fetch('someuser'),
      (err: unknown) => err instanceof InstagramConnectorError && err.kind === kind && err.graphCode === code,
    );
  }
  // 803 (not found) is swallowed by fetch() as null by contract; search must
  // surface it as a per-item warning instead.
  const c803 = makeConnector(() => jsonResponse(graphErrorBody(803, 'Cannot find user'), 404), { maxAttempts: 1 });
  assert.equal(await c803.fetch('ghost'), null);
  const c803s = makeConnector(() => jsonResponse(graphErrorBody(803, 'Cannot find user'), 404), {
    maxAttempts: 1,
    discoveryMode: 'usernames',
  });
  const warned = await c803s.search({ query: 'ghost', filters: {}, limit: 5 });
  assert.equal(warned.items.length, 0);
  assert.equal(warned.partial, true);
  assert.ok(warned.warnings.some((w) => w.includes('not find user') || w.includes('Cannot find user')));
});

test('429 is respected: typed rate_limited with Retry-After, never auto-retried', async () => {
  let calls = 0;
  const c = makeConnector(() => {
    calls += 1;
    return jsonResponse(graphErrorBody(4, 'Application request limit reached'), 429, { 'retry-after': '123' });
  }, { maxAttempts: 3 });
  await assert.rejects(
    () => c.fetch('someuser'),
    (err: unknown) =>
      err instanceof InstagramConnectorError && err.kind === 'rate_limited' && err.retryAfterSeconds === 123 && err.retryable === false,
  );
  assert.equal(calls, 1); // no blind retry against a rate limit
});

test('temporary failures (5xx, network) retry with bounded attempts then fail', async () => {
  let calls = 0;
  const c = makeConnector(() => {
    calls += 1;
    return jsonResponse(graphErrorBody(2, 'temporary'), 503);
  }, { maxAttempts: 2, retryBackoffMs: 0 });
  await assert.rejects(
    () => c.fetch('someuser'),
    (err: unknown) => err instanceof InstagramConnectorError && err.kind === 'temporary',
  );
  assert.equal(calls, 2);

  calls = 0;
  const netFail = makeConnector(() => {
    calls += 1;
    throw new TypeError('fetch failed');
  }, { maxAttempts: 2, retryBackoffMs: 0 });
  await assert.rejects(
    () => netFail.fetch('someuser'),
    (err: unknown) => err instanceof InstagramConnectorError && err.kind === 'temporary' && err.retryable,
  );
  assert.equal(calls, 2);
});

test('token never appears in error messages', async () => {
  const c = makeConnector(() => jsonResponse(graphErrorBody(190, 'Invalid access token'), 401), { maxAttempts: 1 });
  try {
    await c.fetch('someuser');
    assert.fail('expected rejection');
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(TOKEN));
  }
});

// ---------------------------------------------------------------------------
// Usernames mode
// ---------------------------------------------------------------------------

test('usernames mode: split/normalize input, expand each, paginate the rest', async () => {
  const { handler, requests } = standardFakeGraph();
  const c = makeConnector(handler, { discoveryMode: 'usernames', pageLimit: 2 });
  const result = await c.search({ query: '@BlueBottle, partsha', filters: {}, limit: 1 });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.payload['username'], 'bluebottle');
  assert.equal(result.items[0]?.externalId, 'id-bluebottle');
  // Content evidence in usernames mode = the profile's own feed (2 items).
  assert.equal((result.items[0]?.payload['posts'] as unknown[]).length, 2);
  assert.ok(result.nextCursor !== undefined);

  const second = await c.search({ filters: {}, limit: 10, cursor: result.nextCursor as string });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]?.payload['username'], 'partsha');
  assert.equal(second.nextCursor, undefined);

  const bdUrls = requests.filter((r) => r.url.includes('business_discovery'));
  assert.equal(bdUrls.length, 2);
});

test('usernames mode: failures become warnings, never fabricated entities', async () => {
  const { handler } = standardFakeGraph({ bdFailures: new Set(['ghost']) });
  const c = makeConnector(handler, { discoveryMode: 'usernames' });
  const result = await c.search({ query: 'bluebottle ghost', filters: {}, limit: 10 });
  assert.equal(result.items.length, 1);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some((w) => w.includes('ghost')));
});

test('usernames mode: empty input is rejected; filters.usernames works', async () => {
  const { handler } = standardFakeGraph();
  const c = makeConnector(handler, { discoveryMode: 'usernames' });
  await assert.rejects(() => c.search({ filters: {}, limit: 10 }), DiscoveryInputError);
  const r = await c.search({ query: '', filters: { usernames: 'bluebottle' }, limit: 10 });
  assert.equal(r.items.length, 1);
});

// ---------------------------------------------------------------------------
// fetch() + healthCheck()
// ---------------------------------------------------------------------------

test('fetch(identifier): username resolves, numeric id rejected, 803 → null', async () => {
  const { handler } = standardFakeGraph();
  const c = makeConnector(handler);
  const entity = await c.fetch('bluebottle');
  assert.ok(entity);
  assert.equal(entity.entityType, 'BUSINESS_PROFILE');
  assert.equal(entity.payload['username'], 'bluebottle');

  await assert.rejects(
    () => c.fetch('17841401441775531'),
    (err: unknown) => err instanceof InstagramConnectorError && err.kind === 'invalid_request',
  );

  const ghostServer = standardFakeGraph({ bdFailures: new Set(['ghost']) });
  const c2 = makeConnector(ghostServer.handler);
  const missing = await c2.fetch('ghost');
  assert.equal(missing, null);
});

test('healthCheck: verifies the authorized token against the owned account', async () => {
  const { handler } = standardFakeGraph();
  const c = makeConnector(handler);
  const ok = await c.healthCheck();
  assert.equal(ok.ok, true);
  assert.ok((ok.reason ?? '').includes('our_shop'));

  const bad = makeConnector(() => jsonResponse(graphErrorBody(190, 'Invalid access token'), 401), { maxAttempts: 1 });
  const down = await bad.healthCheck();
  assert.equal(down.ok, false);
  assert.match(down.reason ?? '', /authorization failed|Invalid access token/);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('pure helpers: hashtag/username normalization + username extraction', () => {
  assert.equal(normalizeHashtag('  ##PrinterParts '), 'printerparts');
  assert.deepEqual(splitUsernames(' @A ,b;;c a'), ['a', 'b', 'c']);
  const media1 = media('m1', 'alice');
  const media2 = media('m2', 'bob');
  assert.deepEqual(extractUsernames([media1, media1, media2, { id: 'x' }]), ['alice', 'bob']);
  assert.equal(profileUrlFor('blue bottle'), 'https://www.instagram.com/blue%20bottle/');
});

// ---------------------------------------------------------------------------
// Full discovery-flow integration (registry → connector → raw → lead → content)
// ---------------------------------------------------------------------------

test('discovery flow E2E with the real INSTAGRAM connector: raw → lead → lead_contents', async () => {
  const { runDiscovery, PersianAwareNormalizer, DbContentIngestor } = await import('../src/index.ts');
  const { FakeHashtagBudgetStore, FakeRawEntityStore, FakeResolver, FakeSources, makeSource } = await import('./fakes.ts');
  const budgetStore = new FakeHashtagBudgetStore();

  const { handler } = standardFakeGraph();
  const registry = new ConnectorRegistry();
  registry.register(new InstagramGraphConnectorFactory(fetchLike(handler)));

  const store = new FakeRawEntityStore();
  const resolver = new FakeResolver();
  const ingested: { externalId: string; count: number }[] = [];
  const contentIngestor = {
    async ingestForLead(input: { externalId: string; payload: Record<string, unknown> }): Promise<number> {
      const items = extractContentItems(input.payload);
      ingested.push({ externalId: input.externalId, count: items.length });
      return items.length;
    },
  };

  const source = makeSource('src-ig', 't1', 'INSTAGRAM', validConfig({ graphBaseUrl: 'https://graph.test' }));
  const outcome = await runDiscovery(
    {
      log: { info: () => undefined, error: () => undefined },
      sources: new FakeSources([source]),
      rawEntities: store,
      normalizer: new PersianAwareNormalizer(),
      resolver,
      connectorRegistry: registry,
      contentIngestor: contentIngestor as unknown as InstanceType<typeof DbContentIngestor>,
      hashtagBudget: budgetStore,
    },
    { sourceId: 'src-ig', query: '#printerparts', maxCandidates: 10 },
    { tenantId: 't1', jobId: 'job-1' },
  );

  assert.equal(outcome.discovered, 2);
  assert.equal(outcome.created, 2);
  assert.equal(outcome.rawPersisted, 2);
  assert.ok(outcome.contentsIngested >= 4);
  // Phase 21: the hashtag query spent the rolling-7d quota (ledger-driven).
  assert.equal(outcome.hashtag, 'printerparts');
  assert.equal(outcome.budgetReused, false);

  // Repeat run: identical payloads → unchanged snapshots, idempotent leads.
  const second = await runDiscovery(
    {
      log: { info: () => undefined, error: () => undefined },
      sources: new FakeSources([source]),
      rawEntities: store,
      normalizer: new PersianAwareNormalizer(),
      resolver,
      connectorRegistry: registry,
      contentIngestor: contentIngestor as unknown as InstanceType<typeof DbContentIngestor>,
      hashtagBudget: budgetStore,
    },
    { sourceId: 'src-ig', query: '#printerparts', maxCandidates: 10 },
    { tenantId: 't1', jobId: 'job-2' },
  );
  assert.equal(second.rawPersisted, 0);
  assert.equal(second.created, 0);
  // Phase 21: the SAME tag within the window is reused for free.
  assert.equal(second.budgetReused, true);

  // Tenant isolation still holds for INSTAGRAM sources.
  await assert.rejects(
    () =>
      runDiscovery(
        {
          log: { info: () => undefined, error: () => undefined },
          sources: new FakeSources([source]),
          rawEntities: store,
          normalizer: new PersianAwareNormalizer(),
          resolver,
          connectorRegistry: registry,
        },
        { sourceId: 'src-ig', query: 'printerparts' },
        { tenantId: 'another-tenant' },
      ),
    (err: Error) => err.name === 'DiscoveryInputError',
  );
});
