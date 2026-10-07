/**
 * Real authorized Instagram connector (Phase 19, ADR-031).
 *
 * Talks ONLY to the official Instagram Graph API with Facebook Login
 * (https://graph.facebook.com/v25.0) using the tenant's own authorized
 * User access token. Two authorized discovery surfaces exist and both are
 * implemented:
 *
 *  1. Hashtag Search — `GET /ig_hashtag_search` + `GET /{ig-hashtag-id}/top_media`
 *     (or `recent_media`). Official quota: max 30 UNIQUE hashtags per
 *     querying professional account per rolling 7-day period; repeat queries
 *     of an already-queried tag do not consume quota. Enforced client-side
 *     with a rolling-window tracker (a refusal happens BEFORE any network
 *     call and is typed, never silently bypassed).
 *
 *  2. Business Discovery — `GET /{app-user-ig-user-id}?fields=business_discovery.
 *     username({username}){...}`. Returns public metadata + first media pages
 *     of other Business/Creator accounts. Meta's docs historically documented
 *     a 30-unique-usernames/7d quota; current docs no longer state it, so the
 *     connector WARNS past 30 unique usernames (per process, per rolling
 *     window) but relies on the API's own errors as the hard boundary.
 *
 * Platform rate limiting (200 calls/user/hour class) is respected: 429s and
 * Graph rate-limit codes map to a typed rate_limited error that is NEVER
 * auto-retried (no evasion, no waiting loops past a tiny transient backoff).
 *
 * Honesty rules (ADR-027/031):
 *  - Capabilities are advertised only for what is genuinely implemented:
 *    profile_search, profile_fetch, content_fetch, engagement_metrics.
 *    location is NOT advertised (the Graph API exposes no address fields via
 *    these surfaces) and email/phone are never manufactured.
 *  - Payloads carry verbatim Graph media objects augmented with convenience
 *    keys; absent fields stay absent. Video/Reel distinction without
 *    media_product_type stays VIDEO (no inference).
 *  - Per-item failures (e.g. a username that is not a professional account)
 *    become warnings + partial results, never fabricated entities.
 *
 * Security: the access token lives in the tenant-scoped source row config,
 * travels only as the Graph-standard `access_token` query parameter, and is
 * never included in errors, logs, or config summaries. Only https base URLs
 * are accepted.
 */

import type {
  ConnectorCapability,
  DiscoveryRequest,
  DiscoveryResult,
  HealthStatus,
  LeadSourceConnector,
  RawEntity,
  SourceMetadata,
} from '@ulip/connectors';

import { DiscoveryInputError } from './contracts.ts';
import type { ConnectorFactory } from './contracts.ts';

// ---------------------------------------------------------------------------
// Typed errors (docs/connectors/INSTAGRAM-CONNECTOR.md error mapping)
// ---------------------------------------------------------------------------

export type InstagramErrorKind =
  | 'rate_limited' // respect + surface; never auto-retried
  | 'auth' // invalid/expired token (Graph code 190)
  | 'permission' // missing app permission (Graph codes 10/200)
  | 'not_found' // username does not exist / not discoverable (code 803)
  | 'invalid_request' // bad parameter or unexpected response shape
  | 'temporary'; // 5xx / network failure — safe to retry once

export class InstagramConnectorError extends Error {
  readonly kind: InstagramErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number | undefined;
  readonly graphCode?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;

  constructor(
    kind: InstagramErrorKind,
    message: string,
    opts: { httpStatus?: number | undefined; graphCode?: number | undefined; retryAfterSeconds?: number | undefined } = {},
  ) {
    super(message);
    this.name = 'InstagramConnectorError';
    this.kind = kind;
    this.retryable = kind === 'temporary';
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts.graphCode !== undefined) this.graphCode = opts.graphCode;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Config parsing (validated without any network call — ADR-027)
// ---------------------------------------------------------------------------

export interface InstagramGraphConfig {
  accessToken: string;
  igUserId: string;
  graphBaseUrl: string;
  graphVersion: string;
  discoveryMode: 'hashtag' | 'usernames';
  /** Media page size for Graph edges (1..50). */
  pageLimit: number;
  /** 'top' (default) or 'recent' hashtag media edge. */
  mediaEdge: 'top' | 'recent';
  /** Expand hashtag results into full business_discovery profiles. */
  expandProfiles: boolean;
  /** Official hashtag quota (30 unique / rolling 7d). Hard client-side block. */
  hashtagBudgetPer7d: number;
  /** Soft warning threshold for unique business_discovery usernames per 7d. */
  businessDiscoveryWarningThreshold: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
}

const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = 'v25.0';

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function asInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Validates source-row config WITHOUT network. Returns the parsed config or a
 * human-readable refusal reason (the registry turns refusals into
 * NOT_CONFIGURED).
 */
export function parseInstagramGraphConfig(config: Record<string, unknown>): { ok: true; config: InstagramGraphConfig } | { ok: false; reason: string } {
  const provider = config['provider'];
  if (typeof provider !== 'string' || provider.length === 0) return { ok: false, reason: 'config.provider is required' };
  if (provider !== 'instagram-graph') {
    return { ok: false, reason: `config.provider must be "instagram-graph" (got "${provider}")` };
  }

  const accessToken = config['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return { ok: false, reason: 'config.accessToken is required (authorized Meta user access token with instagram_basic permissions)' };
  }

  const igUserId = config['igUserId'];
  if (typeof igUserId !== 'string' || igUserId.trim().length === 0) {
    return { ok: false, reason: 'config.igUserId is required (the app user\'s own Instagram professional account ID — Business Discovery is performed on it)' };
  }
  if (!/^\d{3,}$/.test(igUserId.trim())) {
    return { ok: false, reason: 'config.igUserId must be a numeric Instagram user ID' };
  }

  const baseRaw = typeof config['graphBaseUrl'] === 'string' && config['graphBaseUrl'].trim() !== '' ? config['graphBaseUrl'].trim() : DEFAULT_GRAPH_BASE_URL;
  if (!baseRaw.startsWith('https://')) return { ok: false, reason: 'config.graphBaseUrl must be https' };

  const versionRaw = typeof config['graphVersion'] === 'string' && config['graphVersion'].trim() !== '' ? config['graphVersion'].trim() : DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(versionRaw)) return { ok: false, reason: `config.graphVersion must match v<major>.<minor> (got "${versionRaw}")` };

  const modeRaw = typeof config['discoveryMode'] === 'string' ? config['discoveryMode'].trim() : 'hashtag';
  if (modeRaw !== 'hashtag' && modeRaw !== 'usernames') {
    return { ok: false, reason: `config.discoveryMode must be "hashtag" or "usernames" (got "${modeRaw}")` };
  }

  const edgeRaw = typeof config['mediaEdge'] === 'string' ? config['mediaEdge'].trim() : 'top';
  if (edgeRaw !== 'top' && edgeRaw !== 'recent') {
    return { ok: false, reason: `config.mediaEdge must be "top" or "recent" (got "${edgeRaw}")` };
  }

  const config0: InstagramGraphConfig = {
    accessToken: accessToken.trim(),
    igUserId: igUserId.trim(),
    graphBaseUrl: baseRaw.replace(/\/+$/, ''),
    graphVersion: versionRaw,
    discoveryMode: modeRaw,
    pageLimit: asInt(config['pageLimit'], 12, 1, 50),
    mediaEdge: edgeRaw,
    expandProfiles: asBool(config['expandProfiles'], true),
    hashtagBudgetPer7d: asInt(config['hashtagBudgetPer7d'], 30, 0, 10_000),
    businessDiscoveryWarningThreshold: asInt(config['businessDiscoveryWarningThreshold'], 30, 0, 100_000),
    requestTimeoutMs: asInt(config['requestTimeoutMs'], 15_000, 1_000, 120_000),
    maxAttempts: asInt(config['maxAttempts'], 2, 1, 5),
    retryBackoffMs: asInt(config['retryBackoffMs'], 500, 0, 30_000),
  };
  return { ok: true, config: config0 };
}

// ---------------------------------------------------------------------------
// Rolling-window quota tracking (in-memory, per connector instance)
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tracks unique keys inside a rolling 7-day window. Already-seen keys do not
 * consume budget (mirrors Meta's documented hashtag quota semantics).
 * In-memory per connector instance: conservative for single-process runs;
 * horizontally scaled deployments must budget across processes via config.
 */
export class RollingWindowQuota {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private prune(t: number): void {
    for (const [k, ts] of this.seen) {
      if (t - ts >= SEVEN_DAYS_MS) this.seen.delete(k);
    }
  }

  uniqueCount(): number {
    this.prune(this.now());
    return this.seen.size;
  }

  has(key: string): boolean {
    this.prune(this.now());
    return this.seen.has(key);
  }

  /** True when the key is (or becomes) within budget; false = would exceed. */
  tryAcquire(key: string, budget: number): boolean {
    const t = this.now();
    this.prune(t);
    if (this.seen.has(key)) return true; // repeats never consume quota
    if (budget > 0 && this.seen.size >= budget) return false;
    this.seen.set(key, t);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Cursor codec (opaque, typed, strictly validated)
// ---------------------------------------------------------------------------

type InstagramCursor =
  | { t: 'ig-hashtag'; tag: string; edge: 'top' | 'recent'; after: string }
  | { t: 'ig-usernames'; remaining: string[] };

export function encodeCursor(c: InstagramCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): InstagramCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new DiscoveryInputError('discovery cursor is invalid (not decodable)');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new DiscoveryInputError('discovery cursor is invalid');
  const c = parsed as Record<string, unknown>;
  if (c['t'] === 'ig-hashtag') {
    if (typeof c['tag'] !== 'string' || c['tag'] === '') throw new DiscoveryInputError('discovery cursor is invalid (missing tag)');
    if (c['edge'] !== 'top' && c['edge'] !== 'recent') throw new DiscoveryInputError('discovery cursor is invalid (bad media edge)');
    if (typeof c['after'] !== 'string' || c['after'] === '') throw new DiscoveryInputError('discovery cursor is invalid (missing page cursor)');
    return { t: 'ig-hashtag', tag: c['tag'], edge: c['edge'], after: c['after'] };
  }
  if (c['t'] === 'ig-usernames') {
    const remaining = c['remaining'];
    if (!Array.isArray(remaining) || remaining.some((u) => typeof u !== 'string' || u === '')) {
      throw new DiscoveryInputError('discovery cursor is invalid (bad username list)');
    }
    return { t: 'ig-usernames', remaining: remaining as string[] };
  }
  throw new DiscoveryInputError('discovery cursor is invalid (unknown kind)');
}

// ---------------------------------------------------------------------------
// Graph response shapes (untrusted; defensively narrowed)
// ---------------------------------------------------------------------------

interface GraphMedia {
  id?: unknown;
  caption?: unknown;
  media_type?: unknown;
  media_product_type?: unknown;
  media_url?: unknown;
  thumbnail_url?: unknown;
  permalink?: unknown;
  timestamp?: unknown;
  like_count?: unknown;
  comments_count?: unknown;
  username?: unknown;
  [k: string]: unknown;
}

interface GraphPaging {
  cursors?: { after?: unknown; before?: unknown };
}

interface GraphErrorBody {
  error?: { message?: unknown; code?: unknown; error_subcode?: unknown; type?: unknown; fbtrace_id?: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Normalizes a hashtag: strips leading '#', trims, lowercases. */
export function normalizeHashtag(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase();
}

/** Splits a usernames query ("a, b\nc") into unique trimmed usernames. */
export function splitUsernames(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const u = part.trim().replace(/^@/, '').toLowerCase();
    if (u === '' || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload mapping (verbatim Graph fields + Phase 18 content-ingestion keys)
// ---------------------------------------------------------------------------

/**
 * One lead_contents-ready post: the VERBATIM Graph media object augmented
 * with the convenience keys the Phase 18 extractor understands
 * (published_at / likes / comments). Nothing Graph returned is dropped.
 */
export function mediaToPost(m: GraphMedia): Record<string, unknown> {
  const post: Record<string, unknown> = { ...m };
  if (typeof m['timestamp'] === 'string') post['published_at'] = m['timestamp'];
  if (typeof m['like_count'] === 'number') post['likes'] = m['like_count'];
  if (typeof m['comments_count'] === 'number') post['comments'] = m['comments_count'];
  return post;
}

/** Distinct media-owner usernames, in first-seen order (defensive). */
export function extractUsernames(media: readonly GraphMedia[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of media) {
    const u = str(m['username']);
    if (u === undefined || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

const BD_PROFILE_FIELDS =
  'username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,id';
// Public fields on the hashtag media and business_discovery media edges
// (media_product_type is NOT public on these surfaces — requesting it fails
// with Graph code 100 — so Reels are reported as media_type=VIDEO, honestly).
export const MEDIA_FIELDS =
  'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username';

/** Public profile URL derived from the username (standard, derivable). */
export function profileUrlFor(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

const INSTAGRAM_CAPABILITIES: ReadonlySet<ConnectorCapability> = new Set<ConnectorCapability>([
  'profile_search',
  'profile_fetch',
  'content_fetch',
  'engagement_metrics',
]);

interface FetchLike {
  (url: string, init?: { signal?: AbortSignal; method?: string }): Promise<Response>;
}

export class InstagramGraphConnector implements LeadSourceConnector {
  readonly cfg: InstagramGraphConfig;
  private readonly fetchImpl: FetchLike;
  private readonly hashtagQuota = new RollingWindowQuota();
  private readonly bdSeen = new RollingWindowQuota();

  constructor(cfg: InstagramGraphConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  metadata(): SourceMetadata {
    return { type: 'INSTAGRAM', displayName: 'Instagram Graph API (authorized)', version: '1.0.0' };
  }

  capabilities(): ReadonlySet<ConnectorCapability> {
    return INSTAGRAM_CAPABILITIES;
  }

  supports(capability: ConnectorCapability): boolean {
    return INSTAGRAM_CAPABILITIES.has(capability);
  }

  /** Exposed for tests: proves credentials stayed intact without leaking them. */
  configSummary(): { provider: string; igUserId: string; hasToken: boolean; discoveryMode: string } {
    return { provider: 'instagram-graph', igUserId: this.cfg.igUserId, hasToken: this.cfg.accessToken.length > 0, discoveryMode: this.cfg.discoveryMode };
  }

  // ------------------------------------------------------------------ search

  async search(request: DiscoveryRequest): Promise<DiscoveryResult> {
    if (this.cfg.discoveryMode === 'usernames') return this.searchUsernames(request);
    return this.searchHashtag(request);
  }

  /**
   * Hashtag Search mode: `request.query` is a hashtag ("printerparts" or
   * "#printerparts"). Flow: ig_hashtag_search → top/recent media page →
   * group by owner → business_discovery expansion (default on) → one
   * BUSINESS_PROFILE RawEntity per distinct owner.
   */
  private async searchHashtag(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const rawQuery = (request.query ?? '').trim();
    if (rawQuery === '') {
      throw new DiscoveryInputError('INSTAGRAM hashtag discovery requires query (a hashtag, e.g. "printerparts")');
    }
    const tag = normalizeHashtag(rawQuery);
    if (tag === '') throw new DiscoveryInputError('INSTAGRAM hashtag discovery requires a non-empty hashtag');

    const filters = request.filters ?? {};
    const edge: 'top' | 'recent' = filters['mediaEdge'] === 'recent' ? 'recent' : filters['mediaEdge'] === 'top' ? 'top' : this.cfg.mediaEdge;
    const expand = filters['expandProfiles'] === 'false' ? false : filters['expandProfiles'] === 'true' ? true : this.cfg.expandProfiles;

    let after: string | undefined;
    if (request.cursor !== undefined && request.cursor !== '') {
      const c = decodeCursor(request.cursor);
      if (c.t !== 'ig-hashtag') throw new DiscoveryInputError('discovery cursor does not match INSTAGRAM hashtag mode');
      if (normalizeHashtag(c.tag) !== tag || c.edge !== edge) {
        throw new DiscoveryInputError('discovery cursor belongs to a different hashtag/edge; restart discovery without the cursor');
      }
      after = c.after;
    }

    // Official quota: 30 unique hashtags / rolling 7d — refused BEFORE the
    // network call; repeat tags within the window are free.
    if (!this.hashtagQuota.tryAcquire(tag, this.cfg.hashtagBudgetPer7d)) {
      throw new InstagramConnectorError(
        'rate_limited',
        `hashtag "${tag}" would exceed the authorized quota of ${this.cfg.hashtagBudgetPer7d} unique hashtags per rolling 7-day period for this account; try again later or use an already-queried tag`,
      );
    }

    const warnings: string[] = [];
    const hashtagId = await this.resolveHashtagId(tag);

    const mediaParams = new URLSearchParams({
      user_id: this.cfg.igUserId,
      fields: MEDIA_FIELDS,
      limit: String(Math.min(Math.max(request.limit, 1), 50)),
    });
    if (after !== undefined) mediaParams.set('after', after);
    const page = await this.graphGet(`/${hashtagId}/${edge}_media`, mediaParams);
    const media = readMediaData(page, `hashtag ${edge} media`);

    const usernames = extractUsernames(media);
    const ownerless = media.filter((m) => str(m['username']) === undefined);
    if (ownerless.length > 0) {
      const ids = ownerless.slice(0, 5).map((m) => str(m['id']) ?? '(no id)').join(', ');
      warnings.push(
        `${ownerless.length} media item(s) without an owner username were skipped (no attribution available): ${ids}`,
      );
    }

    const limited = usernames.slice(0, Math.max(request.limit, 1));
    const items: RawEntity[] = [];
    const collectedAt = new Date().toISOString();

    for (const username of limited) {
      const ownerMedia = media.filter((m) => str(m['username']) === username);
      if (expand) {
        try {
          const bd = await this.businessDiscovery(username, this.cfg.pageLimit);
          items.push(this.profileEntity(bd, username, ownerMedia, { mode: 'hashtag', hashtag: tag, mediaEdge: edge }, collectedAt));
        } catch (err) {
          warnings.push(
            `business_discovery for "${username}" failed (${err instanceof Error ? err.message : String(err)}); emitted media-evidence-only entity`,
          );
          items.push(this.mediaOnlyEntity(username, ownerMedia, { mode: 'hashtag', hashtag: tag, mediaEdge: edge }, collectedAt));
        }
      } else {
        items.push(this.mediaOnlyEntity(username, ownerMedia, { mode: 'hashtag', hashtag: tag, mediaEdge: edge }, collectedAt));
      }
    }

    const nextAfter = readPagingAfter(page);
    let nextCursor: string | undefined;
    if (nextAfter !== undefined && items.length > 0) {
      nextCursor = encodeCursor({ t: 'ig-hashtag', tag, edge, after: nextAfter });
    }

    const bdUnique = this.bdSeen.uniqueCount();
    if (expand && this.cfg.businessDiscoveryWarningThreshold > 0 && bdUnique > this.cfg.businessDiscoveryWarningThreshold) {
      warnings.push(
        `${bdUnique} unique usernames queried via Business Discovery in this rolling 7-day window (historical provider quota: 30)`,
      );
    }

    return { items, partial: warnings.length > 0, warnings, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  /**
   * Usernames mode: `request.query` (or filters.usernames) is a list of
   * usernames. Each is resolved via Business Discovery; failures become
   * warnings (never fabricated entities). Truncated lists paginate through
   * nextCursor.
   */
  private async searchUsernames(request: DiscoveryRequest): Promise<DiscoveryResult> {
    let usernames: string[];
    if (request.cursor !== undefined && request.cursor !== '') {
      const c = decodeCursor(request.cursor);
      if (c.t !== 'ig-usernames') throw new DiscoveryInputError('discovery cursor does not match INSTAGRAM usernames mode');
      usernames = c.remaining;
    } else {
      const raw = (request.query ?? '').trim() !== '' ? (request.query ?? '') : ((request.filters ?? {})['usernames'] ?? '');
      if (raw.trim() === '') {
        throw new DiscoveryInputError('INSTAGRAM usernames discovery requires query or filters.usernames (one or more usernames)');
      }
      usernames = splitUsernames(raw);
      if (usernames.length === 0) throw new DiscoveryInputError('INSTAGRAM usernames discovery requires at least one valid username');
    }

    const limit = Math.max(request.limit, 1);
    const batch = usernames.slice(0, limit);
    const remaining = usernames.slice(limit);

    const warnings: string[] = [];
    const items: RawEntity[] = [];
    const collectedAt = new Date().toISOString();

    for (const username of batch) {
      try {
        const bd = await this.businessDiscovery(username, this.cfg.pageLimit);
        // In usernames mode the profile's own media feed is the content
        // evidence (business_discovery media edge, first page).
        const feed = readMediaData(bd['media'] as Record<string, unknown> | undefined, `business_discovery media for "${username}"`);
        items.push(this.profileEntity(bd, str(bd['username']) ?? username, feed, { mode: 'usernames' }, collectedAt));
      } catch (err) {
        warnings.push(`business_discovery for "${username}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let nextCursor: string | undefined;
    if (remaining.length > 0) nextCursor = encodeCursor({ t: 'ig-usernames', remaining });

    return { items, partial: warnings.length > 0, warnings, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  // ------------------------------------------------------------------- fetch

  /**
   * Fetches one business profile by USERNAME via Business Discovery
   * (identifier that is not a username — e.g. a numeric Graph ID — is
   * rejected: the authorized API has no ID→username resolution surface).
   * Returns null when the account does not exist / is not discoverable.
   */
  async fetch(identifier: string): Promise<RawEntity | null> {
    const username = identifier.trim().replace(/^@/, '').toLowerCase();
    if (username === '' || /^\d+$/.test(username)) {
      throw new InstagramConnectorError(
        'invalid_request',
        'INSTAGRAM fetch(identifier) accepts an Instagram username; the authorized API exposes no ID→username lookup',
      );
    }
    let bd: Record<string, unknown>;
    try {
      bd = await this.businessDiscovery(username, this.cfg.pageLimit);
    } catch (err) {
      if (err instanceof InstagramConnectorError && err.kind === 'not_found') return null;
      throw err;
    }
    const feed = readMediaData(bd['media'] as Record<string, unknown> | undefined, `business_discovery media for "${username}"`);
    return this.profileEntity(bd, str(bd['username']) ?? username, feed, { mode: 'fetch' }, new Date().toISOString());
  }

  // ------------------------------------------------------------- healthCheck

  async healthCheck(): Promise<HealthStatus> {
    try {
      const params = new URLSearchParams({ fields: 'id,username' });
      const res = await this.graphGet(`/${this.cfg.igUserId}`, params);
      const username = str(res['username']);
      return { ok: true, ...(username !== undefined ? { reason: `authorized as @${username}` } : {}) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // --------------------------------------------------------------- internals

  /** Builds a BUSINESS_PROFILE RawEntity from a Business Discovery payload. */
  private profileEntity(
    bd: Record<string, unknown>,
    fallbackUsername: string,
    extraMedia: readonly GraphMedia[],
    query: { mode: 'hashtag'; hashtag: string; mediaEdge: string } | { mode: 'usernames' } | { mode: 'fetch' },
    collectedAt: string,
  ): RawEntity {
    const bdMedia = readMediaData(bd['media'] as Record<string, unknown> | undefined, 'business_discovery media');
    const username = str(bd['username']) ?? fallbackUsername;
    const graphId = str(bd['id']) ?? username;

    // Verbatim BD feed + (hashtag mode) the owner's hashtag media — merged in
    // first-seen order; both are preserved verbatim.
    const posts: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();
    for (const m of [...bdMedia, ...extraMedia]) {
      const id = str(m['id']) ?? `${posts.length}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      posts.push(mediaToPost(m));
    }

    const payload: Record<string, unknown> = {
      graph_id: graphId,
      username,
      full_name: str(bd['name']) ?? username,
      name: str(bd['name']),
      biography: str(bd['biography']) ?? null,
      website: str(bd['website']) ?? null,
      external_url: str(bd['website']),
      profile_url: profileUrlFor(username),
      followers_count: typeof bd['followers_count'] === 'number' ? bd['followers_count'] : null,
      follows_count: typeof bd['follows_count'] === 'number' ? bd['follows_count'] : null,
      media_count: typeof bd['media_count'] === 'number' ? bd['media_count'] : null,
      profile_picture_url: str(bd['profile_picture_url']) ?? null,
      profile_evidence: 'business_discovery',
      // NOTE: no wall-clock field here — collectedAt is recorded separately on
      // raw_entities/lead_contents, so identical Graph data + identical query
      // produce identical payload hashes (raw-snapshot idempotency).
      source_query: query,
      posts,
    };

    return {
      sourceType: 'INSTAGRAM',
      externalId: graphId,
      entityType: 'BUSINESS_PROFILE',
      payload,
      collectedAt,
    };
  }

  /** Entity built from hashtag media only (expansion failed or disabled). */
  private mediaOnlyEntity(
    username: string,
    media: readonly GraphMedia[],
    query: { mode: 'hashtag'; hashtag: string; mediaEdge: string },
    collectedAt: string,
  ): RawEntity {
    const posts = media.map((m) => mediaToPost(m));
    return {
      sourceType: 'INSTAGRAM',
      externalId: username,
      entityType: 'BUSINESS_PROFILE',
      payload: {
        username,
        full_name: username,
        biography: null,
        website: null,
        external_url: null,
        profile_url: profileUrlFor(username),
        followers_count: null,
        media_count: null,
        profile_picture_url: null,
        profile_evidence: 'hashtag_media_only',
        source_query: query,
        posts,
      },
      collectedAt,
    };
  }

  /** `GET /ig_hashtag_search` → the hashtag's Graph ID. */
  private async resolveHashtagId(tag: string): Promise<string> {
    const params = new URLSearchParams({ user_id: this.cfg.igUserId, q: tag });
    const res = await this.graphGet('/ig_hashtag_search', params);
    const data = res['data'];
    if (!Array.isArray(data) || data.length === 0) {
      throw new InstagramConnectorError('not_found', `hashtag "${tag}" was not found or is not queryable via the authorized API`);
    }
    const first = data[0];
    if (!isRecord(first)) throw new InstagramConnectorError('invalid_request', 'unexpected ig_hashtag_search response shape');
    const id = str(first['id']);
    if (id === undefined) throw new InstagramConnectorError('invalid_request', 'unexpected ig_hashtag_search response shape (missing id)');
    return id;
  }

  /**
   * Business Discovery: profile fields + first `limit` feed media for one
   * professional account. One Graph call per username.
   */
  private async businessDiscovery(username: string, mediaLimit: number): Promise<Record<string, unknown>> {
    // budget 0 ⇒ never blocks; the tracker only feeds the search-flow warning.
    this.bdSeen.tryAcquire(username, 0);
    const fields = `business_discovery.username(${username}){${BD_PROFILE_FIELDS},media.limit(${mediaLimit}){${MEDIA_FIELDS}}}`;
    const params = new URLSearchParams({ fields });
    const res = await this.graphGet(`/${this.cfg.igUserId}`, params);
    const bd = res['business_discovery'];
    if (!isRecord(bd)) {
      throw new InstagramConnectorError('invalid_request', `business_discovery returned no data for "${username}" (account may be private, age-gated, or not a professional account)`);
    }
    return bd;
  }

  /**
   * Authenticated GET against the configured Graph base URL. Maps HTTP/Graph
   * errors to typed kinds; retries ONLY temporary/network failures (bounded),
   * never rate limits. The token never appears in any error or log line.
   */
  private async graphGet(path: string, params: URLSearchParams): Promise<Record<string, unknown>> {
    if (path.startsWith('/') === false) throw new Error('internal: graph path must start with /');
    params.set('access_token', this.cfg.accessToken);
    const url = `${this.cfg.graphBaseUrl}/${this.cfg.graphVersion}${path}?${params.toString()}`;

    let lastError: InstagramConnectorError | undefined;
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url);
        if (res.ok) {
          const body = (await res.json()) as unknown;
          if (!isRecord(body)) {
            throw new InstagramConnectorError('invalid_request', `unexpected Graph response shape from ${path}`);
          }
          return body;
        }
        const mapped = await mapHttpError(path, res);
        lastError = mapped;
      } catch (err) {
        if (err instanceof InstagramConnectorError) {
          lastError = err;
        } else {
          lastError = new InstagramConnectorError('temporary', `network failure calling ${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (lastError !== undefined && !lastError.retryable) throw lastError;
      if (attempt < this.cfg.maxAttempts && lastError !== undefined) {
        await sleep(this.cfg.retryBackoffMs * attempt);
      }
    }
    throw lastError ?? new InstagramConnectorError('temporary', `request to ${path} failed without an error`);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal, method: 'GET' });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

async function mapHttpError(path: string, res: Response): Promise<InstagramConnectorError> {
  let graphCode: number | undefined;
  let graphMessage: string | undefined;
  let subcode: number | undefined;
  try {
    const body = (await res.json()) as unknown;
    if (isRecord(body) && isRecord(body['error'])) {
      const e = body['error'] as GraphErrorBody['error'] & Record<string, unknown>;
      if (typeof e['code'] === 'number') graphCode = e['code'];
      if (typeof e['message'] === 'string') graphMessage = e['message'];
      if (typeof e['error_subcode'] === 'number') subcode = e['error_subcode'];
    }
  } catch {
    // body was not JSON — fall through to status-based mapping
  }
  const suffix = graphMessage !== undefined ? `: ${graphMessage}` : '';
  const base = { httpStatus: res.status, ...(graphCode !== undefined ? { graphCode } : {}) } as const;

  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;

  if (res.status === 429 || graphCode === 4 || graphCode === 9 || graphCode === 17 || graphCode === 32 || graphCode === 613) {
    return new InstagramConnectorError(
      'rate_limited',
      `Instagram rate limit reached on ${path}${suffix}${subcode !== undefined ? ` (subcode ${subcode})` : ''}`,
      { ...base, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) },
    );
  }
  if (graphCode === 190) {
    return new InstagramConnectorError('auth', `Instagram authorization failed on ${path} (token invalid or expired)${suffix}`, base);
  }
  if (graphCode === 10 || graphCode === 200) {
    return new InstagramConnectorError(
      'permission',
      `Instagram permission denied on ${path} (granted permissions do not cover this call — check instagram_basic/instagram_manage_insights/pages_read_engagement and app review)${suffix}`,
      base,
    );
  }
  if (graphCode === 803) {
    return new InstagramConnectorError('not_found', `Instagram object not found on ${path}${suffix}`, base);
  }
  if (graphCode === 100 || graphCode === 2500) {
    return new InstagramConnectorError('invalid_request', `Instagram rejected the request on ${path}${suffix}`, base);
  }
  if (res.status >= 500) {
    return new InstagramConnectorError('temporary', `Instagram temporarily unavailable on ${path} (HTTP ${res.status})${suffix}`, base);
  }
  return new InstagramConnectorError('invalid_request', `Instagram request failed on ${path} (HTTP ${res.status})${suffix}`, base);
}

function readMediaData(container: Record<string, unknown> | undefined, what: string): GraphMedia[] {
  if (container === undefined) return [];
  const data = container['data'];
  if (data === undefined) return [];
  if (!Array.isArray(data)) {
    throw new InstagramConnectorError('invalid_request', `unexpected ${what} response shape (data is not an array)`);
  }
  return data.filter(isRecord) as GraphMedia[];
}

function readPagingAfter(body: Record<string, unknown>): string | undefined {
  const media = body['media'];
  let paging: unknown;
  if (isRecord(media)) {
    paging = media['paging']; // business_discovery media edge
  } else {
    paging = body['paging']; // hashtag media edge
  }
  if (!isRecord(paging)) return undefined;
  const cursors = paging['cursors'];
  if (!isRecord(cursors)) return undefined;
  return str(cursors['after']);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory (ADR-027: validate without network; register per source type)
// ---------------------------------------------------------------------------

export class InstagramGraphConnectorFactory implements ConnectorFactory {
  readonly sourceType = 'INSTAGRAM';

  private readonly fetchImpl: FetchLike | undefined;

  /**
   * Optional fetchImpl injection for deterministic tests; production builds
   * use global fetch against the authorized Graph base URL.
   */
  constructor(fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl;
  }

  canBuild(config: Record<string, unknown>): { ok: boolean; reason?: string } {
    const parsed = parseInstagramGraphConfig(config);
    return parsed.ok ? { ok: true } : { ok: false, reason: parsed.reason };
  }

  build(config: Record<string, unknown>): InstagramGraphConnector {
    const parsed = parseInstagramGraphConfig(config);
    if (!parsed.ok) throw new Error(`cannot build INSTAGRAM connector: ${parsed.reason}`);
    return this.fetchImpl !== undefined
      ? new InstagramGraphConnector(parsed.config, this.fetchImpl)
      : new InstagramGraphConnector(parsed.config);
  }
}

