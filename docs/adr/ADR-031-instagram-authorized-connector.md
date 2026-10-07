# ADR-031: Real Instagram Authorized Connector & Data Acquisition

**Status:** Accepted (Phase 19)
**Date:** 2026-10-07
**Extends:** ADR-005 (connector architecture), ADR-012 (raw data preservation), ADR-026 (social actions honesty), ADR-027 (real discovery pipeline), ADR-030 (content intelligence). Supersedes nothing.

## Context

Phase 15 shipped the discovery pipeline with an honest placeholder for
Instagram: `ConfiguredHttpApiConnectorFactory('INSTAGRAM')` — a credential-
validating boundary that advertised NO capabilities because no authorized
Instagram adapter existed. Any `DISCOVERY` job against an INSTAGRAM source
failed honestly with `NOT_CONFIGURED`/`UNSUPPORTED`.

Phase 19 replaces that placeholder with a real connector against Meta's
official, authorized surface — with no scraping, no credential sharing, no
anti-bot/anti-rate-limit evasion, ever.

## Decision

### 1. The authorized provider: Instagram Graph API with Facebook Login

ULIP talks to `https://graph.facebook.com/v25.0` using the tenant's own Meta
User access token (config `provider: 'instagram-graph'`,
`accessToken`, `igUserId` — the app user's own Instagram professional
account ID). Two authorized discovery surfaces exist and both are implemented:

- **Hashtag Search** — `GET /ig_hashtag_search` + `GET /{ig-hashtag-id}/top_media`
  (or `recent_media`). Official quota: **30 unique hashtags per querying
  professional account per rolling 7-day period**; repeat queries of an
  already-queried tag are free. Enforced client-side (`RollingWindowQuota`)
  with a refusal BEFORE any network call — typed, never bypassed.
- **Business Discovery** — `GET /{app-user-ig-user-id}?fields=business_discovery.
  username({username}){...}`. Public profile fields + first media page of other
  Business/Creator accounts. Meta's docs historically documented a
  30-unique-usernames/7d quota; current docs no longer state it, so the
  connector WARNS past 30 unique usernames (per process, rolling window) and
  treats the API's own errors as the hard boundary.

Required permission set (granted via Meta app review, held by the tenant):
`instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`
(plus `ads_management`/`ads_read`/`business_management` when the Page role is
granted via Business Manager). The connector never assumes permissions; Graph
error codes map to typed failures.

### 2. One factory, registered where the placeholder was

`InstagramGraphConnectorFactory` (sourceType `INSTAGRAM`) lives in
`@ulip/discovery` next to the other factories and replaces the placeholder
registration in the API composer and worker registry. Pipeline, stores,
normalizer, resolver, content ingestion and the API contract are unchanged —
`ConnectorRegistry.resolveFor` still returns `NOT_CONFIGURED` when the source
row lacks instagram-graph credentials, and the deterministic fake connector
still exists for local E2E only (`allowFake` opt-in).

### 3. Honest capabilities

Advertised: `profile_search`, `profile_fetch`, `content_fetch`,
`engagement_metrics` — each backed by a real implementation.
NOT advertised: `location` (Graph exposes no address fields via these
surfaces), `image_fetch` (binary media retrieval is not the connector's job).
Email/phone/city are never manufactured. `media_product_type` is not public
on these edges, so Reels surface as `media_type=VIDEO` — recorded, never
inferred into REEL.

### 4. Identity & idempotency

With Business Discovery expansion (default), `externalId` is the account's
canonical Graph ID; without expansion (hashtag-only evidence), it is the
username. Payloads contain no wall-clock fields — `collectedAt` is recorded
separately on `raw_entities`/`lead_contents` — so identical Graph data plus an
identical query yields identical payload hashes and fully idempotent re-runs.
Media are grouped per owner and embedded verbatim (Graph fields preserved) as
`posts`, augmented only with the convenience keys the Phase 18 extractor
reads (`published_at`, `likes`, `comments`).

### 5. Typed error mapping, respectful retry

`InstagramConnectorError` kinds: `rate_limited` (HTTP 429 / Graph codes 4, 9,
17, 32, 613 — surfaced with `Retry-After` when present, NEVER auto-retried),
`auth` (190), `permission` (10/200), `not_found` (803), `invalid_request`
(100/2500 and unmapped 4xx), `temporary` (5xx/network — bounded retry,
default 2 attempts). Per-item Business Discovery failures (private,
age-gated, or non-professional accounts) degrade to warnings +
media-evidence-only entities with `partial: true` — never fabricated
entities. The access token never appears in any error, log line, or config
summary.

### 6. Pagination

`search()` consumes one Graph media page per call and returns an opaque,
strictly-validated cursor (`base64url` JSON, typed discriminator) when the
provider reports more pages; the existing job `cursor` field carries it —
no pipeline changes. Usernames mode paginates the remaining username list
the same way.

## Consequences

- INSTAGRAM sources with valid credentials now run REAL discovery end to end:
  connector → raw snapshot → normalization → dedup/ER → lead →
  `lead_contents` → analysis. Without credentials the pipeline still fails
  with `NOT_CONFIGURED` — nothing pretends.
- Live behavior additionally depends on the tenant's Meta app review status
  and the official quotas above; the client-side budget is configurable
  (`hashtagBudgetPer7d`, `businessDiscoveryWarningThreshold`).
- Live smoke testing is a separate, explicit, env-gated script
  (`pnpm smoke:instagram`) — it is never part of CI and never runs without
  credentials.
- The connector is written as a reusable source adapter pattern (factory +
  registry + capability negotiation), so the next provider (Google Maps,
  LinkedIn, YouTube, …) is one factory + one registration, per ADR-027.
