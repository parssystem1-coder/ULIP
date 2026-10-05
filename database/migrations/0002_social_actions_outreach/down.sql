-- 0002_social_actions_outreach — down migration (mirrors up.sql exactly)

BEGIN;

-- Restore the original job type constraint (0001 shape).
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (
  'DISCOVERY', 'NORMALIZATION', 'DEDUP', 'ANALYSIS', 'SCORING', 'EXPORT', 'REPROCESS'));

DROP TABLE IF EXISTS suppression_entries CASCADE;
DROP TABLE IF EXISTS lead_contact_history CASCADE;
DROP TABLE IF EXISTS outreach_recipients CASCADE;
DROP TABLE IF EXISTS outreach_campaigns CASCADE;
DROP TABLE IF EXISTS message_templates CASCADE;

DROP TABLE IF EXISTS social_action_attempts CASCADE;
DROP TABLE IF EXISTS social_actions CASCADE;

DROP TYPE IF EXISTS suppression_scope;
DROP TYPE IF EXISTS outreach_recipient_status;
DROP TYPE IF EXISTS outreach_campaign_status;
DROP TYPE IF EXISTS message_template_status;
DROP TYPE IF EXISTS contact_direction;
DROP TYPE IF EXISTS contact_channel;
DROP TYPE IF EXISTS social_action_attempt_outcome;
DROP TYPE IF EXISTS social_action_status;
DROP TYPE IF EXISTS social_action_type;
DROP TYPE IF EXISTS social_action_capability;

COMMIT;
