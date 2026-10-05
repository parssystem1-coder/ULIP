-- 002_policies_example.sql — example scoring/decision policies (development seed).
-- Thresholds are PERSISTED and versioned; nothing lives only in prose.

BEGIN;

WITH p AS (
  INSERT INTO scoring_policies (id, tenant_id, name, description)
  VALUES ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
          'default', 'Default scoring policy (seed example)')
  RETURNING id
)
INSERT INTO scoring_policy_versions (id, policy_id, version, weights, thresholds, status, effective_from)
SELECT '50000000-0000-0000-0000-000000000002', p.id, 1,
       '{"relevance":0.40,"audienceQuality":0.20,"activity":0.25,"confidence":0.15}',
       '{"qualifiedMin":80,"reviewMin":60,"rejectMax":40}',
       'ACTIVE', now()
FROM p;

WITH p AS (
  INSERT INTO decision_policies (id, tenant_id, name, description)
  VALUES ('51000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
          'default', 'Default decision policy (seed example)')
  RETURNING id
)
INSERT INTO decision_policy_versions (id, policy_id, version,
  accept_threshold, review_threshold, reject_threshold, fallback_threshold,
  use_decision_provider, decision_strategy, status, effective_from)
SELECT '51000000-0000-0000-0000-000000000002', p.id, 1,
       0.90, 0.70, 0.40, 0.60,
       FALSE, 'LLM_ONLY', 'ACTIVE', now()
FROM p;

COMMIT;

-- Down-seed:
-- DELETE FROM scoring_policy_versions WHERE id = '50000000-0000-0000-0000-000000000002';
-- DELETE FROM scoring_policies         WHERE id = '50000000-0000-0000-0000-000000000001';
-- DELETE FROM decision_policy_versions WHERE id = '51000000-0000-0000-0000-000000000002';
-- DELETE FROM decision_policies        WHERE id = '51000000-0000-0000-0000-000000000001';
