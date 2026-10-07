/**
 * Live Instagram Graph API smoke test (Phase 19, OPTIONAL).
 *
 * Explicitly configured live test — runs NOTHING unless credentials are
 * present in the environment:
 *
 *   INSTAGRAM_GRAPH_ACCESS_TOKEN  — Meta user access token with
 *                                   instagram_basic (+ discovery permissions)
 *   INSTAGRAM_GRAPH_IG_USER_ID    — the app user's own IG professional ID
 *   INSTAGRAM_SMOKE_HASHTAG       — optional hashtag to query (default: coffee)
 *   INSTAGRAM_SMOKE_USERNAME      — optional username for Business Discovery
 *
 * Usage: pnpm --filter universal-lead-intelligence-platform smoke:instagram
 * (or: node --experimental-strip-types infra/scripts/instagram-smoke.ts)
 *
 * Missing env ⇒ exits 0 with an explicit NOT_CONFIGURED message (CI-safe).
 * Failures are printed verbatim (token never printed) and exit 1.
 */

interface GraphErr {
  error?: { message?: unknown; code?: unknown };
}

const token = process.env['INSTAGRAM_GRAPH_ACCESS_TOKEN'];
const igUserId = process.env['INSTAGRAM_GRAPH_IG_USER_ID'];
const version = process.env['INSTAGRAM_GRAPH_VERSION'] ?? 'v25.0';
const base = process.env['INSTAGRAM_GRAPH_BASE_URL'] ?? 'https://graph.facebook.com';
const hashtag = (process.env['INSTAGRAM_SMOKE_HASHTAG'] ?? 'coffee').replace(/^#+/, '');
const username = process.env['INSTAGRAM_SMOKE_USERNAME'];

function note(msg: string): void {
  console.log(msg);
}

function fail(step: string, detail: unknown): never {
  console.error(`✖ ${step}`, detail);
  process.exit(1);
}

if (token === undefined || token === '' || igUserId === undefined || igUserId === '') {
  note('NOT_CONFIGURED: INSTAGRAM_GRAPH_ACCESS_TOKEN / INSTAGRAM_GRAPH_IG_USER_ID are not set.');
  note('Live smoke test skipped (no credentials). Connector itself is covered by mocked tests.');
  process.exit(0);
}

async function call(path: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const qs = new URLSearchParams({ ...params, access_token: token ?? '' });
  const res = await fetch(`${base}/${version}${path}?${qs.toString()}`, { method: 'GET' });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

// 1. Token + owned account (health check equivalent)
{
  const r = await call(`/${igUserId}`, { fields: 'id,username' });
  if (!r.ok) fail('health check', sanitize(r.body));
  note(`✔ authorized as @${String(r.body['username'] ?? '(unknown)')} (id ${String(r.body['id'] ?? igUserId)})`);
}

// 2. Hashtag search (official quota surface)
{
  const s = await call('/ig_hashtag_search', { user_id: igUserId ?? '', q: hashtag });
  if (!s.ok) fail(`ig_hashtag_search(${hashtag})`, sanitize(s.body));
  const data = s.body['data'] as { id?: string }[] | undefined;
  const tagId = data?.[0]?.id;
  if (tagId === undefined) fail(`ig_hashtag_search(${hashtag})`, 'no hashtag id in response');
  note(`✔ hashtag #${hashtag} → id ${tagId}`);

  const m = await call(`/${tagId}/top_media`, {
    user_id: igUserId ?? '',
    fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,username',
    limit: '3',
  });
  if (!m.ok) fail('top_media', sanitize(m.body));
  const media = (m.body['data'] as unknown[] | undefined) ?? [];
  note(`✔ top_media returned ${media.length} item(s)`);
  for (const item of media) {
    const it = item as Record<string, unknown>;
    note(`   - ${String(it['id'])} by @${String(it['username'] ?? '(none)')} [${String(it['media_type'])}] likes=${String(it['like_count'] ?? '-')}`);
  }
}

// 3. Business Discovery (optional)
if (username !== undefined && username !== '') {
  const fields = `business_discovery.username(${username}){username,name,biography,followers_count,media_count,media.limit(3){id,caption,media_type,permalink,timestamp,like_count,comments_count}}`;
  const r = await call(`/${igUserId}`, { fields });
  if (!r.ok) fail(`business_discovery(${username})`, sanitize(r.body));
  const bd = r.body['business_discovery'] as Record<string, unknown> | undefined;
  if (bd === undefined) fail(`business_discovery(${username})`, 'no business_discovery payload (account may not be professional)');
  note(`✔ business_discovery @${String(bd['username'])} — followers ${String(bd['followers_count'] ?? '-')}, media ${String(bd['media_count'] ?? '-')}`);
}

note('\nLIVE SMOKE OK — authorized Instagram Graph API reachable and answering.');
process.exit(0);

function sanitize(body: Record<string, unknown>): unknown {
  const err = (body as GraphErr)['error'];
  if (err !== undefined && err !== null) {
    return { graphCode: err.code, message: typeof err.message === 'string' ? err.message : 'unknown error' };
  }
  return body;
}
