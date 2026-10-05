-- 0002_social_actions_outreach — Social Actions + Outreach (ADR-026)
--
-- Adds the persistent model for provider-agnostic social actions and
-- campaign-based outreach. All tables are tenant-scoped and auditable;
-- external actions are idempotent ((tenant_id, idempotency_key) UNIQUE) and
-- retry-safe (attempts per action; SENT recipients are never re-messaged).
-- Bulk execution reuses the persistent jobs infrastructure (job type
-- OUTREACH). This migration NEVER touches discovery/AI tables.

BEGIN;

-- =====================================================================
-- 1. ENUMS
-- =====================================================================

-- Action capabilities advertised honestly by providers (never assumed).
CREATE TYPE social_action_capability AS ENUM (
  'OPEN_PROFILE',
  'FOLLOW_PROFILE',
  'UNFOLLOW_PROFILE',
  'SEND_MESSAGE',
  'BULK_SEND_MESSAGE'
);

CREATE TYPE social_action_type AS ENUM (
  'OPEN_PROFILE',
  'FOLLOW_PROFILE',
  'UNFOLLOW_PROFILE',
  'SEND_MESSAGE'
);

CREATE TYPE social_action_status AS ENUM (
  'PENDING',
  'AWAITING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NOT_SUPPORTED',
  'MANUAL_FALLBACK'
);

CREATE TYPE social_action_attempt_outcome AS ENUM (
  'SUCCESS',
  'RETRYABLE_FAILURE',
  'FATAL_FAILURE',
  'NOT_SUPPORTED'
);

CREATE TYPE contact_channel AS ENUM (
  'DIRECT_MESSAGE',
  'PROFILE_VISIT',
  'FOLLOW',
  'UNFOLLOW',
  'OTHER'
);

CREATE TYPE contact_direction AS ENUM ('OUTBOUND', 'MANUAL');

CREATE TYPE message_template_status AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE outreach_campaign_status AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE outreach_recipient_status AS ENUM (
  'PENDING',
  'ELIGIBLE',
  'QUEUED',
  'SENT',
  'FAILED',
  'SKIPPED',
  'CANCELLED'
);

CREATE TYPE suppression_scope AS ENUM ('LEAD', 'BUSINESS', 'EMAIL', 'PHONE', 'DOMAIN');

-- =====================================================================
-- 2. SOCIAL ACTIONS
-- =====================================================================

-- One row per action intent; idempotent per tenant+key. The rendered
-- message is sensitive (retention policy applies — see docs/security/RETENTION-POLICY.md).
CREATE TABLE social_actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  lead_id           UUID NOT NULL REFERENCES leads(id),
  source_type       TEXT NOT NULL CHECK (source_type <> ''),
  type              social_action_type NOT NULL,
  status            social_action_status NOT NULL DEFAULT 'PENDING',
  idempotency_key   TEXT NOT NULL CHECK (idempotency_key <> ''),
  external_id       TEXT,
  profile_url       TEXT,
  rendered_message  TEXT,
  campaign_id       UUID,
  template_id       UUID,
  actor_id          UUID REFERENCES users(id),
  error_code        TEXT,
  error_message     TEXT,
  executed_at       TIMESTAMPTZ,
  manual_completed_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- idempotency: the same tenant+key can never execute twice
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_social_actions_tenant_status ON social_actions (tenant_id, status, created_at DESC);
CREATE INDEX idx_social_actions_lead ON social_actions (tenant_id, lead_id, created_at DESC);

-- campaign/template FKs are added after those tables exist (see below).

-- One row per provider call attempt; retry-after is stored (respected, never evaded).
CREATE TABLE social_action_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  action_id     UUID NOT NULL REFERENCES social_actions(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL CHECK (attempt_no >= 1),
  outcome       social_action_attempt_outcome NOT NULL,
  error_code    TEXT,
  error_message TEXT,
  retry_after_at TIMESTAMPTZ,
  provider_ref  TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  UNIQUE (action_id, attempt_no)
);

CREATE INDEX idx_action_attempts_tenant ON social_action_attempts (tenant_id, action_id);

-- =====================================================================
-- 3. MESSAGE TEMPLATES
-- =====================================================================

CREATE TABLE message_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  body        TEXT NOT NULL CHECK (body <> ''),
  variables   JSONB NOT NULL DEFAULT '[]',   -- extracted {{placeholders}}
  status      message_template_status NOT NULL DEFAULT 'ACTIVE',
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- =====================================================================
-- 4. OUTREACH CAMPAIGNS + RECIPIENTS
-- =====================================================================

-- filters reuse the universal business model (business_type/industry/
-- specialty/sub_specialty + location) exactly like campaign filters.
CREATE TABLE outreach_campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  description   TEXT,
  filters       JSONB NOT NULL DEFAULT '{}',
  template_id   UUID NOT NULL REFERENCES message_templates(id),
  status        outreach_campaign_status NOT NULL DEFAULT 'DRAFT',
  job_id        UUID REFERENCES jobs(id),
  approved_by   UUID REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outreach_campaigns_tenant ON outreach_campaigns (tenant_id, status, created_at DESC);

-- Now that message_templates and outreach_campaigns exist, attach the deferred FKs:
ALTER TABLE social_actions
  ADD CONSTRAINT fk_social_actions_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id),
  ADD CONSTRAINT fk_social_actions_template FOREIGN KEY (template_id) REFERENCES message_templates(id);

-- One row per (campaign, lead) → ONE separate message per selected lead.
CREATE TABLE outreach_recipients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  campaign_id         UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  lead_id             UUID NOT NULL REFERENCES leads(id),
  status              outreach_recipient_status NOT NULL DEFAULT 'PENDING',
  ineligibility_reason TEXT,
  source_type         TEXT,
  external_id         TEXT,
  profile_url         TEXT,
  rendered_message    TEXT,
  social_action_id    UUID REFERENCES social_actions(id),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at             TIMESTAMPTZ,
  failure_code        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);

CREATE INDEX idx_outreach_recipients_campaign ON outreach_recipients (tenant_id, campaign_id, status);

-- =====================================================================
-- 5. LEAD CONTACT HISTORY + SUPPRESSION
-- =====================================================================

CREATE TABLE lead_contact_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  lead_id          UUID NOT NULL REFERENCES leads(id),
  campaign_id      UUID REFERENCES outreach_campaigns(id),
  social_action_id UUID REFERENCES social_actions(id),
  channel          contact_channel NOT NULL,
  direction        contact_direction NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  summary          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contact_history_lead ON lead_contact_history (tenant_id, lead_id, occurred_at DESC);

-- Suppression always wins: a suppressed lead is never contacted again.
CREATE TABLE suppression_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  scope       suppression_scope NOT NULL,
  lead_id     UUID REFERENCES leads(id),
  business_id UUID REFERENCES businesses(id),
  value_text  TEXT,
  reason      TEXT NOT NULL CHECK (reason <> ''),
  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_suppression_target CHECK (
       (scope = 'LEAD' AND lead_id IS NOT NULL)
    OR (scope = 'BUSINESS' AND business_id IS NOT NULL)
    OR (scope IN ('EMAIL', 'PHONE', 'DOMAIN') AND value_text IS NOT NULL)
  ),
  UNIQUE (tenant_id, scope, lead_id, business_id, value_text)
);

CREATE INDEX idx_suppression_lookup ON suppression_entries (tenant_id, scope, lead_id, business_id);

-- =====================================================================
-- 6. JOBS: OUTREACH TYPE (persistent jobs infrastructure reuse)
-- =====================================================================

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (
  'DISCOVERY', 'NORMALIZATION', 'DEDUP', 'ANALYSIS', 'SCORING', 'EXPORT', 'REPROCESS', 'OUTREACH'));

COMMIT;
