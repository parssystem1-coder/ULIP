-- ULIP migration policy (authoritative evolution mechanism)

Layout:

    database/migrations/NNNN_slug/up.sql
    database/migrations/NNNN_slug/down.sql

Rules:

1. Every schema change ships as a migration; `database/schema/schema.sql` is only
   a human-readable snapshot. Do not edit the snapshot directly when changing
   the schema — write a migration, then regenerate/patch the snapshot to match.
2. Migrations run in lexical/numeric order exactly once (tracked by the migration
   tool chosen in Phase 1 — e.g. node-pg-migrate or dbmate).
3. Down migrations must exist for every up migration from day one.
4. Rolling-deploy compatibility: expand → migrate → contract for destructive change.
5. Seeds live in `database/seeds/` and are never part of schema migrations.
6. No manual production schema edits. No exceptions.

Current migrations:

- `0001_initial_core` — full remediated core schema (mirrors schema.sql snapshot).
- `0002_social_actions_outreach` — social actions, message templates, outreach
  campaigns/recipients, lead contact history, suppression entries, and the
  `OUTREACH` job type (ADR-026). Mirrored in `database/schema/schema.sql`.
- `0003_runtime_auth` — `users.api_key_hash` for the API-key authentication
  boundary (Phase 14). Mirrored in `database/schema/schema.sql`.

Note: the SQL files in this directory are plain, runner-agnostic SQL. The Phase 1
task wraps them with the chosen runner's naming/tracking conventions.
