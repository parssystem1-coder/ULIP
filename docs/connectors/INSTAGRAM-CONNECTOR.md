# Instagram Connector (Phase 19 — implemented)

## Status

```text
IMPLEMENTED — real authorized connector against the Instagram Graph API
TESTED WITH MOCKS — deterministic fake Graph server covers the full suite
LIVE AUTHORIZATION SMOKE TEST — optional, explicit, env-gated (pnpm smoke:instagram)
```

The connector (`InstagramGraphConnector` + `InstagramGraphConnectorFactory`,
sourceType `INSTAGRAM`, in `@ulip/discovery/src/instagram.ts`, ADR-031) talks
ONLY to Meta's official Instagram Graph API with Facebook Login
(`https://graph.facebook.com/v25.0`) using the tenant's own authorized token.
No scraping. No session extraction. No anti-bot, CAPTCHA, or rate-limit
evasion — anywhere, ever.

## Source configuration (sources.config JSONB)

```json
{
  "provider": "instagram-graph",          // required, exactly this value
  "accessToken": "<Meta user access token>", // required; instagram_basic + discovery permissions
  "igUserId": "17841405309211844",        // required; the app user's own IG professional account ID
  "graphBaseUrl": "https://graph.facebook.com", // optional, https enforced
  "graphVersion": "v25.0",                // optional, v<major>.<minor>
  "discoveryMode": "hashtag",             // optional: "hashtag" (default) | "usernames"
  "pageLimit": 12,                        // optional: media page size, 1..50
  "mediaEdge": "top",                     // optional: "top" (default) | "recent"
  "expandProfiles": true,                 // optional: business_discovery expansion per owner
  "hashtagBudgetPer7d": 30,               // optional: client-side hard quota (official: 30)
  "businessDiscoveryWarningThreshold": 30,// optional: soft warning threshold
  "requestTimeoutMs": 15000,              // optional
  "maxAttempts": 2,                       // optional: bounded retries for temporary failures only
  "retryBackoffMs": 500                   // optional
}
```

Missing credentials ⇒ the registry refuses with `NOT_CONFIGURED` (validated
without any network call). Nothing pretends.

## Capabilities (advertised = implemented)

| Capability | Status | Backing API |
| --- | --- | --- |
| `profile_search` | **SUPPORTED** | Hashtag Search (`ig_hashtag_search` + `top_media`/`recent_media`) or username list + Business Discovery |
| `profile_fetch` | **SUPPORTED** | Business Discovery by username (`fetch(identifier)`; numeric IDs rejected — no ID→username surface exists) |
| `content_fetch` | **SUPPORTED** | `business_discovery.media` first page, embedded as payload `posts` |
| `engagement_metrics` | **SUPPORTED** | `like_count`/`comments_count` on media (public fields only) |
| `location` | **NOT_SUPPORTED** | Graph exposes no address fields on these surfaces |
| `image_fetch` | **NOT_SUPPORTED** | Binary media retrieval is not the connector's job |

## Discovery modes

**Hashtag (default)** — `query` is a hashtag (`"#PrinterParts"` or
`printerparts`): `ig_hashtag_search` → media page → group by owner →
Business Discovery expansion (default ON) → one `BUSINESS_PROFILE` RawEntity
per owner. `filters`: `mediaEdge` (`top`/`recent`), `expandProfiles`
(`true`/`false`).

**Usernames** — `discoveryMode: "usernames"`; `query` (or
`filters.usernames`) is a username list (`"@a, b; c"`). Each becomes a
Business Discovery call; failures become warnings, never fabricated entities.

## Pagination

`search()` returns one Graph media page per call. When the provider reports
more, `nextCursor` carries an opaque, strictly-validated cursor that flows
through the existing discovery-job `cursor` field. Wrong-mode or mismatched
cursors are rejected as `DiscoveryInputError`.

## Quotas and rate limits (respected, never bypassed)

- **Hashtag Search**: 30 unique hashtags / rolling 7 days per querying
  account (official). Repeats of an already-queried tag are free. A new tag
  beyond budget is refused BEFORE the network call with a typed
  `rate_limited` error.
- **Business Discovery**: 30 unique usernames / rolling 7 days is the
  historical documented quota; current docs no longer state it. The
  connector records unique usernames per process and emits a warning past
  the threshold; Graph's own errors are the hard boundary.
- **Platform rate limiting**: HTTP 429 and Graph codes 4/9/17/32/613 map to
  a typed `rate_limited` error (with `Retry-After` when present) that is
  NEVER auto-retried.

## Error mapping (typed, token-free)

| Condition | Kind | Behavior |
| --- | --- | --- |
| HTTP 429 / Graph 4, 9, 17, 32, 613 | `rate_limited` | surfaced, never auto-retried |
| Graph 190 | `auth` | job fails; token invalid/expired |
| Graph 10 / 200 | `permission` | app review / permission gap |
| Graph 803 | `not_found` | `fetch()` → null; search → warning |
| Graph 100 / 2500, unknown 4xx | `invalid_request` | job fails |
| HTTP 5xx / network | `temporary` | bounded retry (default 2), then job fails |

Per-item Business Discovery failures (private, age-gated, non-professional
accounts) degrade to warnings + `hashtag_media_only` entities with
`partial: true`.

## Payload shape (feeds normalization + Phase 18 content intelligence)

```json
{
  "graph_id": "17841401441775531",
  "username": "bluebottle",
  "full_name": "Blue Bottle Coffee",
  "biography": "…", "website": "…", "external_url": "…",
  "profile_url": "https://www.instagram.com/bluebottle/",
  "followers_count": 267793, "follows_count": 42, "media_count": 1205,
  "profile_picture_url": "…",
  "profile_evidence": "business_discovery",   // or "hashtag_media_only"
  "source_query": { "mode": "hashtag", "hashtag": "printerparts", "mediaEdge": "top" },
  "posts": [ { "id": "…", "caption": "…", "media_type": "IMAGE|VIDEO|CAROUSEL_ALBUM",
               "media_url": "…", "permalink": "…", "timestamp": "…",
               "like_count": 101, "comments_count": 7,
               "published_at": "…", "likes": 101, "comments": 7 } ]
}
```

- `posts` are the VERBATIM Graph media objects + three convenience keys
  (`published_at`, `likes`, `comments`) the Phase 18 extractor reads.
- No wall-clock fields inside the payload ⇒ identical Graph data + identical
  query ⇒ identical payload hash ⇒ idempotent raw snapshots and re-runs.
- Missing fields stay absent/null; email/phone/city are never manufactured;
  Reels without `media_product_type` (not public on these edges) stay
  `media_type=VIDEO`.

## Social action capabilities (ADR-026 — unchanged)

| Action | Status | Notes |
| --- | --- | --- |
| `OPEN_PROFILE` | **SUPPORTED** | Navigation to the lead's public profile URL — no mutation, no bypass. |
| `FOLLOW_PROFILE` / `UNFOLLOW_PROFILE` / `SEND_MESSAGE` / `BULK_SEND_MESSAGE` | **NOT_SUPPORTED** | No authorized follow/DM API in this integration → manual fallback. |

## Live smoke test (optional, explicit)

```bash
export INSTAGRAM_GRAPH_ACCESS_TOKEN=...
export INSTAGRAM_GRAPH_IG_USER_ID=...
export INSTAGRAM_SMOKE_USERNAME=bluebottle   # optional Business Discovery check
pnpm smoke:instagram
```

Without credentials the script prints `NOT_CONFIGURED …` and exits 0
(CI-safe). It is never part of the automated test suite.

## Platform boundary

Do not add techniques whose purpose is to bypass authentication barriers,
CAPTCHA, anti-bot controls, rate limits, or other platform security/access
controls. The connector surfaces limits honestly and stops.
