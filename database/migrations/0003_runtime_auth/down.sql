-- 0003_runtime_auth — down migration

BEGIN;

DROP INDEX IF EXISTS uniq_users_api_key_hash;
ALTER TABLE users DROP COLUMN IF EXISTS api_key_hash;

COMMIT;
