# ULIP Architecture Remediation Report

Scope: full blueprint reconciliation per the Master Remediation Prompt. Status: **completed**.
Verification gate: `cd blueprint && pnpm build` → **exit 0** (strict typecheck + 28/28 tests green).

## A. Remediation matrix (issue → resolution)

| # | Issue | Sev | Root cause | Files changed | Impact | Status |
|---|-------|-----|-----------|---------------|--------|--------|
| 1 | No Analysis Orchestrator / state machine owner | P0 | pipeline jobs listed, no lifecycle owner | ORCHESTRATION.md (new), ADR-016, orchestration pkg contracts+tests, schema `leads.status` | DB | Resolved |
| 2 | No persistent job model | P0 | jobs existed only in Redis prose | schema.sql, migration 0001, DATA-DICTIONARY, INDEX-STRATEGY, ERD | DB/API | Resolved |
| 3 | Jev undefined hard dependency; `unknown` in core contracts | P0 | no typed DecisionProvider | ai pkg interfaces (typed, optional strategies), ADR-017, ADR-023, TASK-CONTRACTS, EVALUATION | TS/AI | Resolved |
| 4 | Raw dedup bug (`collected_at` in uniqueness) | P0 | timestamp in identity key | schema.sql (`raw_entities` unique on source+external+content_hash; `raw_entity_currents`) | DB | Resolved |
| 5 | Taxonomy root uniqueness unsafe with NULL parent | P0 | plain UNIQUE ignores NULLs | schema.sql partial unique indexes; db-constraints tests | DB | Resolved (tests Docker-guarded) |
| 6 | No Entity Resolution persistence | P0 | ER was prose-only | schema.sql (`entity_resolution_*`, `entity_merge_events`), ADR-022 | DB | Resolved |
| 7 | Current analysis/score semantics undefined | P0 | version rows without "current" | `is_current` partial unique indexes, ADR-024 | DB/API | Resolved |
| 8 | Profession-centric product model | P0 | Business Type missing | ADR-018, domain contracts, schema, PRD, UX-SPEC, master spec, MASTER-PROMPT, TAXONOMY-ENGINE | all layers | Resolved |
| 9 | Evidence write order invalid (ids referenced before persist) | P0 | no transaction model | EVIDENCE-AND-EXPLAINABILITY.md §write-order | AI | Resolved |
| 10 | OpenAPI behind API.md, `additionalProperties: true` | P0 | no contract authority | OPENAPI.yaml (24 paths, explicit component schemas, ApiError family, Idempotency-Key), ADR-020, API.md §22 | API | Resolved |
| 11 | Persian not first-class | P1 | normalization only prose | domain `persian-normalize.ts` + tests, `taxonomy_node_aliases/_translations`, `location_aliases`, `normalization_rules`, ADR-019 | DB/TS | Resolved |
| 12 | Scoring/decision thresholds in prose | P1 | no config storage | `scoring_policies(+versions)`, `decision_policies(+versions)`, scoring pkg `policy-resolver` + tests, ADR-021 | DB/TS | Resolved |
| 13 | No PII/data-protection model | P1 | privacy prose only | DATA-PROTECTION.md, PII-DATA-MODEL.md, RETENTION-POLICY.md | docs | Resolved |
| 14 | Workspace not buildable | P1 | no workspace config | pnpm-workspace, tsconfigs, per-package manifests, build gate | build | Resolved |
| 15 | Migrations absent | P1 | single snapshot file | migrations/0001_initial_core up+down, README policy, seeds 001/002 (+README) | DB | Resolved |
| 16 | Contact identity model missing | P1 | single phone field | `business_contacts` (typed channels, confidence, availability) | DB | Resolved |
| 17 | Location free-text | P1 | no structure | `business_locations`, `location_aliases`, availability states | DB | Resolved |
| 18 | Phase-count drift (27-phase phantom roadmap) | P2 | two roadmaps | MASTER-PROMPT rewritten to canonical 13 phases; REPOSITORY-FILE-TREE regenerated | docs | Resolved |
| 19 | Stale terminology scan (§72) | P2 | doc drift | see C; remaining hits audited & legitimate | docs | Resolved |
| 20 | License missing | P2 | never added | deferred to owner decision — flagged in README/file-tree as `[C]` placeholder | repo | **Deferred** |
| 21 | DB constraint tests need real Postgres | P3 | env lacked Docker (now installed) | run on real Postgres 16 in Docker — **8/8 green**; schema bugs found & fixed during the run (see D) | tests | **Verified** |

## B. Architecture delta (major)

- **Before:** profession→specialty→city; jobs in Redis only; Jev an undefined always-on stage; "current" undefined; evidence ids referenced before persistence; single schema file; no workspace; 27-phase phantom roadmap.
- **After:** Business Type + Industry + Specialty (+optional levels) + structured Location; DB-owned `jobs`/`job_attempts`/`job_events` with typed lead state machine (ADR-016); Jev = optional typed DecisionProvider behind `DecisionStrategy`/routing (ADR-017); `is_current` partial-unique version semantics (ADR-024); transactional evidence write order; migrations authoritative + snapshot; buildable pnpm workspace with green gate (ADR-025); canonical 13 phases.
- **Reason:** correctness (no broken references/dedup), testability (typed contracts + tests), provider/source independence preserved; no microservices/GNN introduced (§73 respected).

## C. Canonical domain model

`Business`, `Lead`, `BusinessType/Industry/Specialty` (taxonomy node kinds), `Location` (structured + aliases), `Identity` (`lead_identities`, `business_contacts`), `Content`, `Analysis` (`lead_analyses`, current-flagged), `Decision`, `Evidence`, `Score` (`lead_scores` + `audience_quality`), `Job` (`jobs/attempts/events`), `Campaign`. Definitive DDL: [schema.sql](../database/schema/schema.sql); field-level: DATA-DICTIONARY.md; TypeScript mirror: `blueprint/packages/domain/src/contracts.ts`.

## D. Processing state machine

Full transition + failure tables: [ORCHESTRATION.md](architecture/ORCHESTRATION.md), typed in `blueprint/packages/orchestration/src/contracts.ts`, tested in `transitions.test.ts` (6 tests). End-states: QUALIFIED / REVIEW_REQUIRED / REJECTED / FAILED / ARCHIVED.

## E. Final ERD

[ERD.md](database/ERD.md) — updated with jobs, contacts/locations, taxonomy i18n, policies, entity resolution, current-version semantics. Table-level truth: DATABASE.md + DATA-DICTIONARY.md.

## F. Final OpenAPI

[OPENAPI.yaml](api/OPENAPI.yaml) — authoritative (ADR-020): 24 paths, explicit component schemas (Lead, Business, Job, Error family, Pagination…), standardized errors, Idempotency-Key parameters with 409 replay-conflict semantics. API.md mirrors it.

## G. Final file tree

[REPOSITORY-FILE-TREE.md](implementation/REPOSITORY-FILE-TREE.md) — regenerated from the real tree, classified existing/to-be-created/optional; removed seed `001-taxonomy.sql` (superseded).

## H. Master prompt

[MASTER-PROMPT](../../prompts/master/MASTER-PROMPT.md) — phantom 27-phase roadmap replaced by canonical 13-phase table; section numbering fixed; terminology synced.

## I. Phase prompts

`prompts/phases/PHASE-00…PHASE-12` = exactly 13, matching IMPLEMENTATION-PLAN and MASTER-PROMPT (no phantom phases remain; grep-verified).

## D. Real-database verification (PostgreSQL 16, Docker)

Docker became available late in the remediation, so the constraint suite was run
for real — and it caught four genuine schema defects that static review missed:

1. **plpgsql parser trap** — `IF (SELECT …) = CASE … END THEN` in
   `chk_taxonomy_parent_kind` was parsed as a CASE *statement*, consuming the rest
   of the body ("syntax error at end of input"). Fixed by parenthesizing the CASE
   expression and adding explicit `::text` casts (enum = text comparison also
   fails without them).
2. **FK ordering** — `lead_scores.scoring_policy_version_id` declared an inline
   `REFERENCES scoring_policy_versions(id)` before that table existed. Fixed with
   a deferred `ALTER TABLE … ADD CONSTRAINT` in section 8.
3. **Constraint naming** — auto-generated names (`taxonomy_nodes_tenant_id_…`)
   were unnamed/unstable for tests and error handling; now explicit
   `uniq_taxonomy_child` and `uniq_raw_identity_content`.
4. **Collapse semantics made explicit** — identical-payload re-collection is a
   no-op via `ON CONFLICT (source_id, external_id, content_hash) DO NOTHING`
   (documented as the connector ingest contract); a changed payload still
   snapshots. The migration `0001_initial_core/up.sql` also no longer uses the
   psql-only `\ir` meta-command — it carries the schema verbatim so any runner
   (node-pg-migrate, dbmate) works.

Results:

```text
db-constraints.test.ts  (real Postgres 16, docker container)  8/8 PASS
  ✔ schema applies cleanly (all constraints parse)
  ✔ taxonomy root uniqueness (partial index)
  ✔ taxonomy child uniqueness (same slug under different parents)
  ✔ taxonomy hierarchy trigger (parent-kind rule)
  ✔ raw_entities dedup: identical payload collapses, changed payload snapshots
  ✔ current analysis semantics (exactly one is_current row per lead)
  ✔ lead status enum-enforced
  ✔ idempotency_keys unique scope (tenant+scope+key)
seeds 001_core_reference + 002_policies_example applied cleanly
  (19 taxonomy nodes, 8 aliases, 4 location aliases, 1 scoring + 1 decision policy version)
OpenAPI.yaml parsed: valid YAML, OpenAPI 3.0.3, 24 paths, 46 component schemas
```

## Verification & remaining risk

- **Tests run:** 28 unit tests (domain/connectors/ai/scoring/orchestration) + 8 database
  constraint tests on real Postgres 16 — **all 36 pass**; strict `tsc` clean; seeds verified.
- **Could not run:** nothing material; blueprint `pnpm build` gate green (exit 0).
- **Deferred:** LICENSE (owner decision — placeholder file marks it); real connector
  implementations (by design — architecture support ≠ implementation).
- **Remaining risk:** mixed line endings in `schema.sql` (CRLF/LF) — cosmetic, normalize in
  Phase 01; repository still not git-initialized (owner call).
- **Score:** architecture readiness ≈ **8/10 → 9/10** for a blueprint: the three blocking gaps
  (orchestrator, Jev contract, schema bugs) are closed with ADRs, DDL, typed code and tests —
  now verified against a real database, not only by static review.
