-- 0004_evaluation — down migration (mirrors up.sql exactly)

BEGIN;

DROP TRIGGER IF EXISTS trg_evaluation_corrections_immutable ON evaluation_corrections;
DROP TRIGGER IF EXISTS trg_evaluation_case_results_immutable ON evaluation_case_results;
DROP TRIGGER IF EXISTS trg_evaluation_runs_immutable ON evaluation_runs;

DROP FUNCTION IF EXISTS ulip_reject_evaluation_mutation();

DROP TABLE IF EXISTS evaluation_corrections CASCADE;
DROP TABLE IF EXISTS evaluation_case_results CASCADE;
DROP TABLE IF EXISTS evaluation_runs CASCADE;

COMMIT;
