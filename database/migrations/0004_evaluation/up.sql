-- 0004_evaluation — AI evaluation runs, case results and human corrections
-- (Phase 17, ADR-029).
--
-- Reuses the existing conventions:
--   * tenant-owned tables with tenant_id NOT NULL (isolation is structural)
--   * version identifiers are explicit columns, never an implicit "latest"
--   * run ids are DETERMINISTIC references (hash of dataset version + arm +
--     provider + model + prompt + taxonomy + policy) so re-running the same
--     evaluation is idempotent instead of duplicating rows
--   * ai_runs is NOT duplicated: an evaluation run is a measurement over a
--     frozen dataset, not a per-lead provider call, and ai_runs.lead_id is
--     nullable precisely so provider calls stay the single execution ledger
--   * rows are immutable historical facts (trigger-enforced)

BEGIN;

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id                       UUID PRIMARY KEY,
  tenant_id                UUID NOT NULL REFERENCES tenants(id),
  dataset_version          TEXT NOT NULL,
  arm                      TEXT NOT NULL CHECK (arm IN (
                             'RULES_ONLY', 'LLM_ONLY', 'RULES_THEN_LLM',
                             'LLM_THEN_DECISION_PROVIDER', 'RULES_LLM_DECISION_PROVIDER')),
  arm_status               TEXT NOT NULL CHECK (arm_status IN ('EXECUTED', 'NOT_CONFIGURED', 'FAILED')),
  arm_reason               TEXT,
  provider                 TEXT NOT NULL,
  model                    TEXT NOT NULL,
  prompt_version           TEXT NOT NULL,
  schema_version           TEXT NOT NULL,
  taxonomy_version         INTEGER NOT NULL,
  scoring_policy_version   TEXT NOT NULL,
  -- DETERMINISTIC id: callers derive it from the version tuple; uniqueness is
  -- the idempotency guard (same tuple => same row, not a second row).
  started_at               TIMESTAMPTZ NOT NULL,
  finished_at              TIMESTAMPTZ NOT NULL,
  total_cases              INTEGER NOT NULL DEFAULT 0,
  metrics                  JSONB NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_runs_versions_nonempty CHECK (
    dataset_version <> '' AND provider <> '' AND model <> '' AND
    prompt_version <> '' AND schema_version <> '' AND scoring_policy_version <> ''
  )
);

-- Same (tenant, versions, arm) measurement is one run — replays converge.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_evaluation_runs_identity
  ON evaluation_runs (tenant_id, dataset_version, arm, provider, model,
                      prompt_version, schema_version, taxonomy_version,
                      scoring_policy_version);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_tenant_created
  ON evaluation_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_case_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  case_id        TEXT NOT NULL,
  exact_match    BOOLEAN NOT NULL,
  dimension_accuracy NUMERIC(5,4) NOT NULL,
  mean_confidence   NUMERIC(5,4),
  error_category TEXT CHECK (error_category IN (
                   'SOURCE_DATA_MISSING', 'NORMALIZATION_ERROR', 'TAXONOMY_MISMATCH',
                   'MODEL_MISUNDERSTANDING', 'GROUNDING_FAILURE', 'THRESHOLD_ERROR',
                   'SCORING_ERROR', 'HUMAN_LABEL_DISAGREEMENT', 'OTHER')),
  outcome        TEXT,
  outcome_expected TEXT,
  outcome_correct BOOLEAN,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  tokens_input   INTEGER,
  tokens_output  INTEGER,
  estimated_cost NUMERIC(14,6),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_evaluation_case UNIQUE (run_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_case_results_tenant
  ON evaluation_case_results (tenant_id, run_id);

-- Human corrections (§12): recorded SEPARATELY from AI output, never as an
-- update to an analysis/evaluation row.
CREATE TABLE IF NOT EXISTS evaluation_corrections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  run_id         UUID REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id        TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  field          TEXT NOT NULL CHECK (field IN (
                   'businessType', 'industry', 'specialty', 'subSpecialty',
                   'brand', 'location', 'outcome', 'score')),
  original_value JSONB,
  corrected_value JSONB NOT NULL,
  reviewer_id    UUID REFERENCES users(id),
  reviewer_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: an anonymous correction still occupies the same
  -- (tenant, dataset, case, field) slot as any other anonymous correction.
  CONSTRAINT uniq_evaluation_correction
    UNIQUE NULLS NOT DISTINCT (tenant_id, dataset_version, case_id, field, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_corrections_tenant
  ON evaluation_corrections (tenant_id, dataset_version, created_at DESC);

-- ------------------------------------------------------------------ immutability
-- Evaluation history is append-only: a measurement that could be edited after
-- the fact is worthless as a regression baseline.
CREATE OR REPLACE FUNCTION ulip_reject_evaluation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evaluation tables are append-only (historical measurements are immutable)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evaluation_runs_immutable ON evaluation_runs;
CREATE TRIGGER trg_evaluation_runs_immutable
  BEFORE UPDATE OR DELETE ON evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION ulip_reject_evaluation_mutation();

DROP TRIGGER IF EXISTS trg_evaluation_case_results_immutable ON evaluation_case_results;
CREATE TRIGGER trg_evaluation_case_results_immutable
  BEFORE UPDATE OR DELETE ON evaluation_case_results
  FOR EACH ROW EXECUTE FUNCTION ulip_reject_evaluation_mutation();

-- Corrections are appended, not edited (a reviewer's change is a new row).
DROP TRIGGER IF EXISTS trg_evaluation_corrections_immutable ON evaluation_corrections;
CREATE TRIGGER trg_evaluation_corrections_immutable
  BEFORE UPDATE ON evaluation_corrections
  FOR EACH ROW EXECUTE FUNCTION ulip_reject_evaluation_mutation();

COMMIT;
