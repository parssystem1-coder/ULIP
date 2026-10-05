# ADR-027: Real Discovery Pipeline & Honest Source Boundaries

Status: Accepted (Phase 15)
Date: 2026-10-05

## Context

Phase 14 shipped a runnable runtime whose DISCOVERY flow was an explicit
stub. The universal business model (Business Type → Industry → Specialty →
Sub-specialty → Brand → Location) and the raw/normalized/dedup/ER schema
existed, but nothing flowed through them. Separately, no authorized Instagram
discovery API is configured in this project.

## Decision

1. **Pipeline package** `@ulip/discovery` owns the production flow:
   connector → raw snapshot → normalization → dedup/ER → lead →
   ANALYSIS_PENDING. The worker's old stub is removed for supported
   providers; jobs remain DB-backed truth with BullMQ transport-only.

2. **Honest connector resolution** (`ConnectorRegistry`):
   - `UNKNOWN_SOURCE_TYPE` — no factory registered for the source type.
   - `NOT_CONFIGURED` — factory exists but tenant-supplied credentials are
     missing/invalid (validated with zero network calls).
   - `UNSUPPORTED` — connector exists but does not advertise
     `profile_search`, or is a deterministic fake used outside explicit E2E
     opt-in (`allowFake` on the request AND `allowDeterministicFakes`).
   The worker records job outcomes as FAILED with
   `NOT_CONFIGURED`/`BAD_REQUEST`/`WORKER_ERROR` codes rather than
   pretending progress.

3. **First integration is a boundary, not a claim.**
   `ConfiguredHttpApiConnectorFactory` (registered for `INSTAGRAM` and
   `HTTP_API`) validates provider/https-base/token at config time and builds
   a connector that advertises **no** capabilities until a real authorized
   adapter is implemented. When an authorized Instagram Graph integration
   exists, a new factory is registered here and nothing else changes.

4. **No bypass. Ever.** No unofficial scraping, no CAPTCHA/anti-bot evasion,
   no session/cookie extraction, no rate-limit circumvention (extends
   ADR-013 to discovery).

5. **Raw data is immutable.** Every snapshot lands verbatim in
   `raw_entities` keyed by (source, externalId, content-hash); repeats are
   no-ops, changes append revisions and move `raw_entity_currents`. Leads
   dedup via the `lead_identities(source_id, external_id)` identity key;
   same-name candidates inside a tenant create
   `entity_resolution_candidates(UNCERTAIN, PENDING)` rows for review —
   never a silent merge, never uncontrolled duplicates.

6. **Deterministic lifecycle.** Lead states move only through the canonical
   `LEAD_TRANSITION_TABLE` events, applied conditionally so replays are
   idempotent.

## Consequences

- Discovery is testable end-to-end without external credentials (fake
  provider), while production source types stay honestly gated.
- The first real authorized provider requires only a new `ConnectorFactory`;
  pipeline, API, worker, and storage are unchanged.
- Classification hints produced during discovery are RULE-sourced; AI
  analysis (and Jev evaluation) remain later phases.
