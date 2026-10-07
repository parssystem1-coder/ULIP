# Phase 19 — Real Instagram Authorized Connector & Data Acquisition

**Status:** Implemented (see `docs/adr/ADR-031-instagram-authorized-connector.md`).

## Goal

Replace the Phase 15 `INSTAGRAM` placeholder with a REAL connector against
Meta's official, authorized Instagram Graph API — as a reusable source
adapter, not a one-off script. Instagram remains the FIRST source; the
architecture stays provider-agnostic.

## What was built

1. **`@ulip/discovery/src/instagram.ts`** — `InstagramGraphConnector` +
   `InstagramGraphConnectorFactory` (sourceType `INSTAGRAM`):
   - Hashtag Search mode (`ig_hashtag_search` → `top_media`/`recent_media` →
     owner grouping → Business Discovery expansion).
   - Usernames mode (username list → Business Discovery).
   - `fetch(username)`, `healthCheck()`, capability negotiation
     (`profile_search`, `profile_fetch`, `content_fetch`, `engagement_metrics`).
   - `RollingWindowQuota` — official 30-unique-hashtags/7d quota enforced
     client-side BEFORE any network call; repeats stay free.
   - `InstagramConnectorError` — typed kinds (`rate_limited`, `auth`,
     `permission`, `not_found`, `invalid_request`, `temporary`); 429 is
     surfaced with `Retry-After` and never auto-retried; temporary failures
     retry with bounded attempts.
   - Cursor pagination (opaque, strictly validated) through the existing
     discovery-job `cursor` field.
   - Token hygiene: credentials live in the tenant-scoped source row config,
     travel only as the Graph-standard query parameter, and never appear in
     errors, logs, or summaries.

2. **Registration** — API composer + worker registry now register
   `InstagramGraphConnectorFactory` for `INSTAGRAM` (the generic
   `ConfiguredHttpApiConnectorFactory` boundary remains for `HTTP_API`).

3. **Tests** — `packages/discovery/test/instagram.test.ts` (23 tests) against
   a deterministic in-process fake Graph server: config validation, honest
   capability advertisement, both search modes, pagination, quota refusal,
   error mapping, retry semantics, token hygiene, Phase 18 content-extractor
   compatibility, and a full discovery-flow E2E (raw → lead →
   `lead_contents`, idempotent re-run, tenant isolation).

4. **Optional live smoke** — `pnpm smoke:instagram`
   (`infra/scripts/instagram-smoke.ts`): env-gated, CI-safe, prints
   `NOT_CONFIGURED` and exits 0 without credentials.

## Honest boundaries

- Tested with mocks; live authorization smoke test runs only when the
  operator provides credentials.
- Reels surface as `media_type=VIDEO` (`media_product_type` is not public on
  these Graph edges) — recorded, never inferred.
- `location`, `image_fetch`, follow/DM actions remain NOT_SUPPORTED with the
  documented manual fallbacks.
