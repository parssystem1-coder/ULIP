# PHASE 15 — REAL DISCOVERY & FIRST SOURCE INTEGRATION

## Objective

Replace the Phase 14 discovery stub with the real, provider-agnostic
discovery pipeline and wire it into the API and worker while keeping the
honest boundary rules (ADR-013, ADR-027).

## Flow (canonical)

```text
POST /discovery/search  (Idempotency-Key required)
→ persistent Job (DB truth) → BullMQ transport
→ ConnectorRegistry.resolveFor(source)
   UNKNOWN_SOURCE_TYPE | NOT_CONFIGURED | UNSUPPORTED | RESOLVED
→ connector.search(DiscoveryRequest)
→ raw_entities (immutable, content-hash dedup) + raw_entity_currents
→ PersianAwareNormalizer (ADR-019 keys + business-model hints)
→ DbEntityResolver (identity key / ER candidate for same-name)
→ Lead CREATED/UPDATED through LEAD_TRANSITION_TABLE
→ ANALYSIS_PENDING
→ job SUCCEEDED with counts (discovered/created/updated/unchanged)
```

## Rules

- Universal business model filters ride the request:
  `businessType, industry, specialty, subSpecialty, brand, location`.
- No scraping, no CAPTCHA/anti-bot bypass, no session extraction, no
  rate-limit evasion. An unauthorized provider is NEVER claimed supported.
- Deterministic fake connector: local E2E only, requires explicit
  `allowFake: true` on the request; the registry refuses it otherwise.
- Raw snapshots are immutable; provenance (source, collectedAt, payload)
  is preserved even when entities resolve to an existing lead.
- Repeated discovery must be idempotent: same snapshot ⇒ unchanged; same
  identity ⇒ lead UPDATED, not duplicated.

## Definition of Done

- `POST /discovery/search` + `GET /discovery/jobs/{id}` match OPENAPI.yaml.
- Worker runs the real pipeline for supported providers; stub removed.
- Tests: package unit tests (registry gates, normalizer determinism,
  payload validation, tenant isolation, dedup/repeat idempotency),
  worker registry tests, real-stack integration (auth, idempotency replay,
  404 cross-tenant, E2E worker flow, 401 boundary).
- lint/typecheck/test/build green; DB constraint suites green on real PG.
- Docs synced: OPENAPI.yaml, API.md, IMPLEMENTATION-PLAN, ROADMAP,
  REPOSITORY-FILE-TREE, connector docs, ADR-027, this file.
