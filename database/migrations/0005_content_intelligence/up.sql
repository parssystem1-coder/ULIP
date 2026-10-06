-- 0005_content_intelligence — Phase 18 (ADR-030).
--
-- Content becomes a first-class analysis input:
--   * lead_contents.content_type widens to the Instagram-style modality set
--     (POST / REEL / CAROUSEL join the existing TEXT / IMAGE / VIDEO / …).
--   * content_analyses stores ONE versioned content-intelligence result per
--     lead run: sampling strategy, profile-vs-content consistency, activity
--     signals, aggregated content relevance and structured review reasons.
--     Current-version semantics mirror lead_analyses (is_current / superseded_at,
--     partial unique index → exactly one current row per lead).
--   * content_analysis_items stores the per-content-item outcome of one
--     content-analysis version (why it was sampled, which modalities were
--     analyzed, per-item relevance). Historical items are never overwritten:
--     the (content_analysis_id, lead_content_id) pair is unique and ids are
--     deterministic, so a retry of the same run inserts nothing new.
--   * evaluation_runs.arm widens with the Phase 18 comparison arms
--     (PROFILE_ONLY / TEXT_CONTENT / TEXT_IMAGE / FULL_AVAILABLE_EVIDENCE).
--
-- No scraping and no new platform access is introduced here: the tables hold
-- results derived from connector data the tenant is already authorized to read.

BEGIN;

-- 1) Widen content types (Instagram-style modalities). Values are produced by
--    the Persian-aware normalizer from authorized connector payloads only.
ALTER TABLE lead_contents
  DROP CONSTRAINT lead_contents_content_type_check;
ALTER TABLE lead_contents
  ADD CONSTRAINT lead_contents_content_type_check
    CHECK (content_type IN
      ('TEXT', 'IMAGE', 'VIDEO', 'LINK', 'METADATA', 'POST', 'REEL', 'CAROUSEL'));

-- 2) Versioned content-intelligence result (one row per analysis run).
CREATE TABLE content_analyses (
  id                UUID PRIMARY KEY,             -- deterministic (idempotent replays)
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_id       UUID REFERENCES lead_analyses(id) ON DELETE CASCADE,
  analysis_version  TEXT NOT NULL,
  analysis_mode     analysis_mode NOT NULL DEFAULT 'STANDARD',
  sampling          JSONB NOT NULL,               -- { strategy, depth, considered, selected[], budget }
  profile_content_consistency TEXT NOT NULL CHECK (profile_content_consistency IN
                      ('PROFILE_CONTENT_AGREE', 'PROFILE_CONTENT_PARTIAL',
                       'PROFILE_CONTENT_CONFLICT', 'INSUFFICIENT_CONTENT')),
  consistency_confidence NUMERIC(5,4) CHECK (consistency_confidence IS NULL OR
                        (consistency_confidence >= 0 AND consistency_confidence <= 1)),
  activity_signals  JSONB NOT NULL DEFAULT '{}',  -- recency/cadence/recentCount (content-derived)
  content_relevance NUMERIC(5,4) CHECK (content_relevance IS NULL OR
                      (content_relevance >= 0 AND content_relevance <= 1)),
  relevance_criteria TEXT,                        -- requested search criteria when provided
  review_reasons    JSONB NOT NULL DEFAULT '[]',  -- structured reasons only, no chain-of-thought
  summary           TEXT,
  is_current        BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_current = TRUE OR superseded_at IS NOT NULL)
);

-- Exactly one current content analysis per lead (mirrors lead_analyses).
CREATE UNIQUE INDEX uniq_content_analyses_current
  ON content_analyses (lead_id) WHERE is_current = TRUE;
CREATE INDEX idx_content_analyses_lead
  ON content_analyses (lead_id, created_at DESC);

-- 3) Per-content-item outcome of one content-analysis version.
CREATE TABLE content_analysis_items (
  id                  UUID PRIMARY KEY,           -- deterministic
  content_analysis_id UUID NOT NULL REFERENCES content_analyses(id) ON DELETE CASCADE,
  lead_content_id     UUID NOT NULL REFERENCES lead_contents(id) ON DELETE CASCADE,
  content_type        TEXT NOT NULL,
  selected_reasons    JSONB NOT NULL DEFAULT '[]',-- RECENCY | REPRESENTATIVE | HIGH_SIGNAL | TYPE_DIVERSITY | ONLY_AVAILABLE
  text_analyzed       BOOLEAN NOT NULL DEFAULT FALSE,
  image_analyzed      BOOLEAN NOT NULL DEFAULT FALSE,
  media_analyzed      BOOLEAN NOT NULL DEFAULT FALSE,
  modality_notes      JSONB NOT NULL DEFAULT '{}',-- e.g. { "vision": "UNAVAILABLE" } — missing modality recorded explicitly
  relevance           NUMERIC(5,4) CHECK (relevance IS NULL OR
                        (relevance >= 0 AND relevance <= 1)),
  relevance_signals   JSONB NOT NULL DEFAULT '[]',
  topics              JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_analysis_id, lead_content_id)
);

CREATE INDEX idx_content_analysis_items_analysis
  ON content_analysis_items (content_analysis_id);
CREATE INDEX idx_content_analysis_items_content
  ON content_analysis_items (lead_content_id);

-- 4) Phase 18 evaluation arms (content/multimodal comparison).
ALTER TABLE evaluation_runs
  DROP CONSTRAINT evaluation_runs_arm_check;
ALTER TABLE evaluation_runs
  ADD CONSTRAINT evaluation_runs_arm_check
    CHECK (arm IN ('RULES_ONLY', 'LLM_ONLY', 'RULES_THEN_LLM',
                   'LLM_THEN_DECISION_PROVIDER', 'RULES_LLM_DECISION_PROVIDER',
                   'PROFILE_ONLY', 'TEXT_CONTENT', 'TEXT_IMAGE',
                   'FULL_AVAILABLE_EVIDENCE'));

COMMIT;
