-- 0003_runtime_auth — API-key authentication support (Phase 14)
--
-- Adds a hashed API key column to users. Keys are never stored in plain
-- text; lookup is by SHA-256 hash. The resolved user's tenant_id becomes the
-- request tenant context (never client-supplied).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash TEXT;

-- API-key lookup must be fast; partial index only for keyed users.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_api_key_hash
  ON users (api_key_hash)
  WHERE api_key_hash IS NOT NULL;

COMMIT;
