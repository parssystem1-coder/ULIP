-- 0005_content_intelligence — down migration (mirrors up.sql)

BEGIN;

ALTER TABLE evaluation_runs
  DROP CONSTRAINT evaluation_runs_arm_check;
ALTER TABLE evaluation_runs
  ADD CONSTRAINT evaluation_runs_arm_check
    CHECK (arm IN ('RULES_ONLY', 'LLM_ONLY', 'RULES_THEN_LLM',
                   'LLM_THEN_DECISION_PROVIDER', 'RULES_LLM_DECISION_PROVIDER'));

DROP TABLE IF EXISTS content_analysis_items CASCADE;
DROP TABLE IF EXISTS content_analyses CASCADE;

ALTER TABLE lead_contents
  DROP CONSTRAINT lead_contents_content_type_check;
ALTER TABLE lead_contents
  ADD CONSTRAINT lead_contents_content_type_check
    CHECK (content_type IN ('TEXT', 'IMAGE', 'VIDEO', 'LINK', 'METADATA'));

COMMIT;
