-- 0006_hashtag_discovery — down migration (mirrors up.sql)

BEGIN;

DROP INDEX IF EXISTS idx_hbl_tag;
DROP INDEX IF EXISTS idx_hbl_window;
DROP TABLE IF EXISTS hashtag_budget_ledger;

COMMIT;
