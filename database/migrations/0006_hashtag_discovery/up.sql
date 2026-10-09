-- 0006_hashtag_discovery — Phase 21 (persistent hashtag budget ledger).
--
-- Instagram's official Hashtag Search quota is 30 UNIQUE hashtags per
-- querying professional account per ROLLING 7-day period (Meta docs). Re-
-- querying an already-queried tag within the window does NOT consume quota.
--
-- This ledger models that exactly:
--   * one row per (tenant, source, hashtag) QUERY — tenant-scoped, auditable
--     (job_id links the spend to the discovery job that caused it);
--   * consumption is decided by the DB (COUNT within the rolling window inside
--     the inserting transaction), so two concurrent jobs can never both spend
--     past the cap — race safety lives in SQL, not in process memory;
--   * a repeat query of a tag already present in the window reuses that row's
--     timestamp (no budget consumed) — mirroring Meta's documented behavior.
--
-- The in-process RollingWindowQuota in the Instagram connector stays as a
-- second defensive layer; this ledger is the durable source of truth.

BEGIN;

CREATE TABLE hashtag_budget_ledger (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  source_id  UUID NOT NULL REFERENCES sources(id),  -- hashtag queries run on the tenant's professional account (source config)
  hashtag    TEXT NOT NULL,                          -- normalized (ZWNJ stripped, lowercase) before insert
  job_id     UUID REFERENCES jobs(id) ON DELETE SET NULL,
  queried_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling-window lookups are always (tenant, source, time)-shaped.
CREATE INDEX idx_hbl_window ON hashtag_budget_ledger (tenant_id, source_id, queried_at DESC);
-- Repeat-query detection within a window.
CREATE INDEX idx_hbl_tag ON hashtag_budget_ledger (tenant_id, source_id, hashtag, queried_at DESC);

COMMIT;
