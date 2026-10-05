-- 0001_initial_core.down.sql
-- Reverse of the initial migration. Drops every object created by up.sql.
-- After applying, the database is empty except the migration bookkeeping.

DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS usage_counters CASCADE;
DROP TABLE IF EXISTS idempotency_keys CASCADE;
DROP TABLE IF EXISTS exports CASCADE;
DROP TABLE IF EXISTS job_events CASCADE;
DROP TABLE IF EXISTS job_attempts CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS ai_runs CASCADE;
DROP TABLE IF EXISTS model_versions CASCADE;
DROP TABLE IF EXISTS ai_providers CASCADE;
DROP TABLE IF EXISTS human_reviews CASCADE;
DROP TABLE IF EXISTS campaign_leads CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS entity_merge_events CASCADE;
DROP TABLE IF EXISTS entity_resolution_matches CASCADE;
DROP TABLE IF EXISTS entity_resolution_candidates CASCADE;
DROP TABLE IF EXISTS decision_policy_versions CASCADE;
DROP TABLE IF EXISTS decision_policies CASCADE;
DROP TABLE IF EXISTS scoring_policy_versions CASCADE;
DROP TABLE IF EXISTS scoring_policies CASCADE;
DROP TABLE IF EXISTS decisions CASCADE;
DROP TABLE IF EXISTS audience_quality CASCADE;
DROP TABLE IF EXISTS lead_scores CASCADE;
DROP TABLE IF EXISTS evidence CASCADE;
DROP TABLE IF EXISTS lead_classifications CASCADE;
DROP TABLE IF EXISTS lead_analyses CASCADE;
DROP TABLE IF EXISTS lead_contents CASCADE;
DROP TABLE IF EXISTS lead_identities CASCADE;
DROP TABLE IF EXISTS leads CASCADE;
DROP TABLE IF EXISTS business_contacts CASCADE;
DROP TABLE IF EXISTS business_locations CASCADE;
DROP TABLE IF EXISTS businesses CASCADE;
DROP TABLE IF EXISTS location_aliases CASCADE;
DROP TABLE IF EXISTS normalization_rules CASCADE;
DROP TABLE IF EXISTS taxonomy_node_aliases CASCADE;
DROP TABLE IF EXISTS taxonomy_node_translations CASCADE;
DROP TABLE IF EXISTS raw_entity_currents CASCADE;
DROP TABLE IF EXISTS raw_entities CASCADE;
DROP TABLE IF EXISTS source_accounts CASCADE;
DROP TABLE IF EXISTS sources CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS taxonomy_nodes CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

DROP FUNCTION IF EXISTS chk_taxonomy_parent_kind();
DROP TRIGGER IF EXISTS trg_taxonomy_parent_kind ON taxonomy_nodes;

DROP TYPE IF EXISTS review_decision;
DROP TYPE IF EXISTS analysis_mode;
DROP TYPE IF EXISTS decision_status;
DROP TYPE IF EXISTS resolution_status;
DROP TYPE IF EXISTS match_verdict;
DROP TYPE IF EXISTS classification_type;
DROP TYPE IF EXISTS contact_kind;
DROP TYPE IF EXISTS availability;
DROP TYPE IF EXISTS node_kind;
DROP TYPE IF EXISTS job_step;
DROP TYPE IF EXISTS job_status;
DROP TYPE IF EXISTS ingest_status;
DROP TYPE IF EXISTS lead_status;
