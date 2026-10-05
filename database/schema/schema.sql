-- ulip — canonical Postgres schema (v2, remediation 2026-10-04)
--
-- This snapshot mirrors `database/migrations/0001_initial_core/*.up.sql`.
-- Migrations are authoritative for evolution; this file is the readable snapshot.
--
-- Postgres 16. Only built-in extension used: pgcrypto (UUID generation).
-- All lifecycle status values are database-enforced (enums / CHECK constraints).
-- Scoped tables carry tenant_id; tenant context always comes from the
-- authenticated session, never from client-supplied values.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- 1. ENUMS
-- =====================================================================

CREATE TYPE lead_status AS ENUM (
  'DISCOVERED',
  'RAW_STORED',
  'NORMALIZED',
  'DEDUP_CHECKED',
  'ANALYSIS_PENDING',
  'ANALYZING',
  'SCORED',
  'REVIEW_REQUIRED',
  'QUALIFIED',
  'REJECTED',
  'FAILED',
  'ARCHIVED'
);

-- Ingestion-level raw status (drives async ingest jobs; distinct from processing stage).
CREATE TYPE ingest_status AS ENUM ('PENDING', 'PROCESSED', 'DISCARDED');

CREATE TYPE job_status AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED');

CREATE TYPE job_step AS ENUM (
  'DISCOVERY',
  'FETCH',
  'NORMALIZATION',
  'DEDUP',
  'ANALYSIS',
  'VISION',
  'DECISION',
  'EVIDENCE_VALIDATION',
  'SCORING'
);

CREATE TYPE node_kind AS ENUM ('BUSINESS_TYPE', 'INDUSTRY', 'SPECIALTY', 'SUB_SPECIALTY');

CREATE TYPE availability AS ENUM ('AVAILABLE', 'PARTIAL', 'INFERRED', 'UNAVAILABLE');

CREATE TYPE contact_kind AS ENUM ('PHONE', 'MOBILE', 'WHATSAPP', 'EMAIL', 'WEBSITE', 'SOCIAL');

CREATE TYPE classification_type AS ENUM (
  'BUSINESS_TYPE', 'INDUSTRY', 'SPECIALTY', 'SUB_SPECIALTY', 'BRAND', 'OTHER'
);

CREATE TYPE match_verdict AS ENUM ('SAME_ENTITY', 'DIFFERENT_ENTITIES', 'UNCERTAIN');

CREATE TYPE resolution_status AS ENUM ('PENDING', 'MERGED', 'REJECTED', 'SUPERSEDED');

CREATE TYPE decision_status AS ENUM ('ACCEPTED', 'REVIEW_REQUIRED', 'REJECTED', 'ABSTAINED');

-- The analysis pipeline that was applied (BE_REUSE = short-circuit on existing analysis).
CREATE TYPE analysis_mode AS ENUM ('BASIC', 'STANDARD', 'DEEP', 'BE_REUSE');

CREATE TYPE review_decision AS ENUM ('ACCEPT', 'REJECT', 'CORRECT', 'MARK_UNCERTAIN');

-- =====================================================================
-- 2. TENANTS / USERS
-- =====================================================================

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  name        TEXT PRIMARY KEY,
  description TEXT
);

INSERT INTO roles (name, description) VALUES
  ('OWNER',    'Full tenant administration'),
  ('ADMIN',    'Operational administration'),
  ('ANALYST',  'Discovery, analysis, campaigns, exports'),
  ('REVIEWER', 'Review queue and corrections'),
  ('VIEWER',   'Read-only');

CREATE TABLE users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  email      TEXT NOT NULL,
  name       TEXT,
  role       TEXT NOT NULL REFERENCES roles(name),
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- =====================================================================
-- 3. SOURCES / RAW DATA
-- =====================================================================

CREATE TABLE sources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  type       TEXT NOT NULL CHECK (type <> ''),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           UUID NOT NULL REFERENCES sources(id),
  external_account_id TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_account_id)
);

-- Raw observations. "Entity identity" (source, external_id) is separate from
-- immutable "raw snapshots" (same identity, distinct payload hash).
CREATE TABLE raw_entities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      UUID NOT NULL REFERENCES sources(id),
  external_id    TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  payload_json   JSONB NOT NULL,
  content_hash   TEXT NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  ingest_status  ingest_status NOT NULL DEFAULT 'PENDING',
  collected_at   TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_raw_identity_content UNIQUE (source_id, external_id, content_hash)  -- identical payload duplicates collapse via ON CONFLICT DO NOTHING
);

-- Latest raw snapshot per identity (for reprocessing without a search).
CREATE TABLE raw_entity_currents (
  source_id        UUID NOT NULL REFERENCES sources(id),
  external_id      TEXT NOT NULL,
  raw_entity_id    UUID NOT NULL REFERENCES raw_entities(id) ON DELETE CASCADE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, external_id)
);

-- =====================================================================
-- 4. TAXONOMY  (Business Type / Industry / Specialty / Sub-specialty)
-- =====================================================================

CREATE TABLE taxonomy_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  parent_id   UUID REFERENCES taxonomy_nodes(id),
  node_kind   node_kind NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- required hierarchy edge kinds: BT<-I, I<-S, S<-SS (BT/BT and BT<-S forbidden)
  UNIQUE (id, node_kind),
  -- child nodes (parent_id IS NOT NULL)
  CONSTRAINT uniq_taxonomy_child UNIQUE (tenant_id, parent_id, slug),
  CONSTRAINT chk_node_depth CHECK (
       (parent_id IS NULL     AND node_kind = 'BUSINESS_TYPE')
    OR (parent_id IS NOT NULL AND node_kind <> 'BUSINESS_TYPE')
  )
);

-- Root nodes: NULL parent never matches a composite UNIQUE in Postgres.
CREATE UNIQUE INDEX uniq_taxonomy_root_slug
  ON taxonomy_nodes (tenant_id, slug)
  WHERE parent_id IS NULL;

-- Parent must be exactly one level deeper-kind (BUSINESS_TYPE→INDUSTRY→SPECIALTY→SUB_SPECIALTY).
CREATE FUNCTION chk_taxonomy_parent_kind() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF (SELECT node_kind::text FROM taxonomy_nodes WHERE id = NEW.parent_id) =
       (CASE NEW.node_kind::text
         WHEN 'INDUSTRY'      THEN 'BUSINESS_TYPE'
         WHEN 'SPECIALTY'     THEN 'INDUSTRY'
         WHEN 'SUB_SPECIALTY' THEN 'SPECIALTY'
        END) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'taxonomy parent kind mismatch for %', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_taxonomy_parent_kind
  BEFORE INSERT OR UPDATE ON taxonomy_nodes
  FOR EACH ROW EXECUTE FUNCTION chk_taxonomy_parent_kind();

-- Multilingual display (Persian first-class: locale = 'fa' supported).
CREATE TABLE taxonomy_node_translations (
  node_id     UUID NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  name        TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (node_id, locale)
);

-- Alias resolution surfaces ("آرایشگاه زنانه", "سالن زیبایی", "hair salon").
CREATE TABLE taxonomy_node_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     UUID NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  alias_norm  TEXT NOT NULL,   -- after persian-normalize + transliteration + casefold
  locale      TEXT NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Za-z]{2})?$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alias_norm, locale)
);

CREATE INDEX idx_taxonomy_aliases_norm ON taxonomy_node_aliases (alias_norm);

-- Deterministic normalization rules (data, not application code):
-- e.g. Arabic-to-Persian letters, ZWNJ, spelling variants.
CREATE TABLE normalization_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type    TEXT NOT NULL CHECK (rule_type IN ('LETTING', 'TRANSLITERATION', 'SPELLING', 'HALFSPACE', 'PUNCTUATION', 'CITY')),
  locale       TEXT NOT NULL DEFAULT 'fa',
  input_norm   TEXT NOT NULL,   -- normalized input form
  output       TEXT NOT NULL,   -- normalized/alias target form
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_type, locale, input_norm)
);

-- Geographic aliases (Persian ↔ English city names, variants).
CREATE TABLE location_aliases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias        TEXT NOT NULL,
  alias_norm   TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT 'fa',
  country      TEXT NOT NULL,
  province     TEXT,
  city         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_location_alias ON location_aliases (country, alias_norm);

-- =====================================================================
-- 5. BUSINESSES / LEADS
-- =====================================================================

CREATE TABLE businesses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  canonical_name        TEXT NOT NULL,
  description           TEXT,
  business_type_node_id UUID REFERENCES taxonomy_nodes(id),
  industry_node_id      UUID REFERENCES taxonomy_nodes(id),
  website               TEXT,
  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_businesses_type_industry ON businesses (tenant_id, business_type_node_id, industry_node_id);

-- Structured location with provenance; free-text city alone rejected by design.
CREATE TABLE business_locations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  country        TEXT NOT NULL,
  province       TEXT,
  city           TEXT,
  district       TEXT,
  raw_value      TEXT NOT NULL,
  availability   availability NOT NULL DEFAULT 'AVAILABLE',
  confidence     NUMERIC(5,4),
  source_id      UUID REFERENCES sources(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_locations_city ON business_locations (country, city);

-- Contact identity channel (dedup signals, privacy-aware).
CREATE TABLE business_contacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind               contact_kind NOT NULL,
  value              TEXT NOT NULL,
  value_normalized   TEXT NOT NULL,
  availability       availability NOT NULL DEFAULT 'AVAILABLE',
  confidence         NUMERIC(5,4),
  is_sensitive       BOOLEAN NOT NULL DEFAULT FALSE,   -- private/sensitive → restricted exposure
  source_id          UUID REFERENCES sources(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, kind, value_normalized)
);

CREATE TABLE leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  business_id  UUID NOT NULL REFERENCES businesses(id),
  status       lead_status NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (first_seen_at <= last_seen_at)
);

CREATE TABLE lead_identities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_id    UUID NOT NULL REFERENCES sources(id),
  external_id  TEXT NOT NULL,
  username     TEXT,
  profile_url  TEXT,
  display_name TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE INDEX idx_lead_identities_lead ON lead_identities (lead_id);

CREATE TABLE lead_contents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_id         UUID REFERENCES sources(id),
  source_content_id TEXT NOT NULL,
  content_type      TEXT NOT NULL CHECK (content_type IN ('TEXT', 'IMAGE', 'VIDEO', 'LINK', 'METADATA')),
  text              TEXT,        -- bio/caption; untrusted content → never execute as instruction
  media_url         TEXT,
  published_at      TIMESTAMPTZ,
  content_hash      TEXT NOT NULL,  -- provenance fingerprint
  retrieved_at      TIMESTAMPTZ NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, source_content_id, content_hash)
);

CREATE INDEX idx_content_lead_published ON lead_contents (lead_id, published_at DESC);

-- =====================================================================
-- 6. ANALYSIS / EVIDENCE   (current-version semantics)
-- =====================================================================

CREATE TABLE lead_analyses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_version  TEXT NOT NULL,
  model_version     TEXT,
  prompt_version    TEXT,
  schema_version    TEXT,
  taxonomy_version  INTEGER NOT NULL DEFAULT 1,
  analysis_mode     analysis_mode NOT NULL DEFAULT 'STANDARD',
  summary           TEXT,
  structured_output JSONB NOT NULL,
  confidence        NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  is_current        BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_at     TIMESTAMPTZ,          -- NULL while current
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_current = TRUE OR superseded_at IS NOT NULL)
);

-- Exactly one current analysis per lead.
CREATE UNIQUE INDEX uniq_leads_analysis_current ON lead_analyses (lead_id) WHERE is_current = TRUE;
CREATE INDEX idx_leads_analysis_current_existence ON lead_analyses (lead_id, confidence DESC) WHERE is_current = TRUE;

CREATE TABLE evidence (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id          UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_id      UUID REFERENCES lead_analyses(id) ON DELETE CASCADE, -- provenance: created during analysis
  evidence_type    TEXT NOT NULL CHECK (evidence_type IN (
    'BIO_TEXT', 'CAPTION_TEXT', 'IMAGE_OBSERVATION', 'CONTENT_METADATA',
    'LOCATION_SIGNAL', 'PROFILE_METADATA', 'ENGAGEMENT_SIGNAL',
    'MODEL_INFERENCE', 'HUMAN_CORRECTION')),
  source_type      TEXT NOT NULL,
  source_reference TEXT NOT NULL,      -- traceable origin locator; no synthetic provenance allowed
  content          TEXT,               -- OR pointer into object storage
  content_hash     TEXT NOT NULL,
  retrieved_at     TIMESTAMPTZ NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}',
  confidence       NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evidence_lead ON evidence (lead_id);
CREATE INDEX idx_evidence_analysis ON evidence (analysis_id);

CREATE TABLE lead_classifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_id         UUID REFERENCES lead_analyses(id) ON DELETE CASCADE,
  classification_type classification_type NOT NULL,
  taxonomy_node_id    UUID REFERENCES taxonomy_nodes(id),  -- when canonical node exists
  value_text          TEXT,                                -- when no node (e.g. brand "HP")
  value_normalized    TEXT,
  confidence          NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source              TEXT NOT NULL CHECK (source IN ('AI', 'RULE', 'HUMAN')),
  model_version       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (taxonomy_node_id IS NOT NULL OR value_text IS NOT NULL)
);

CREATE INDEX idx_classifications_lead_type ON lead_classifications (lead_id, classification_type);
CREATE INDEX idx_classifications_node ON lead_classifications (taxonomy_node_id);

-- =====================================================================
-- 7. SCORES   (current semantics + policy version)
-- =====================================================================

CREATE TABLE lead_scores (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scoring_policy_version_id UUID NOT NULL,  -- FK added after scoring_policy_versions (section 8)
  relevance_score         NUMERIC(5,2) CHECK (relevance_score BETWEEN 0 AND 100),
  audience_quality_score  NUMERIC(5,2) CHECK (audience_quality_score BETWEEN 0 AND 100),
  activity_score          NUMERIC(5,2) CHECK (activity_score BETWEEN 0 AND 100),
  confidence_score        NUMERIC(5,2) CHECK (confidence_score BETWEEN 0 AND 100),
  priority_score          NUMERIC(5,2) CHECK (priority_score BETWEEN 0 AND 100),
  is_current              BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_current = TRUE OR superseded_at IS NOT NULL)
);

-- Exactly one current score per lead; the API filter uses this directly.
CREATE UNIQUE INDEX uniq_leads_score_current ON lead_scores (lead_id) WHERE is_current = TRUE;
CREATE INDEX idx_leads_scores_current_filters ON lead_scores (relevance_score DESC)
  WHERE is_current = TRUE;

CREATE TABLE audience_quality (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  quality_score  NUMERIC(5,2) CHECK (quality_score BETWEEN 0 AND 100),
  risk_level     TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN')),
  signals        JSONB NOT NULL DEFAULT '[]',
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model_version  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE decisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_id           UUID REFERENCES lead_analyses(id) ON DELETE CASCADE,
  decision_policy_version_id UUID,   -- FK added after decision_policy_versions (section 8)
  decision_type         TEXT NOT NULL CHECK (decision_type <> ''),
  decision_options      JSONB NOT NULL,        -- DecisionOption[] (typed ids, no A/B/C)
  probabilities         JSONB,                 -- { optionId, probability }[]
  selected_option_id    TEXT,
  applied_threshold     NUMERIC(5,4),
  status                decision_status NOT NULL,
  provider              TEXT NOT NULL CHECK (provider <> ''),   -- provider name or 'RULES'
  model_version         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- 8. POLICIES (scoring + decision thresholds)
-- =====================================================================

CREATE TABLE scoring_policies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE scoring_policy_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id      UUID NOT NULL REFERENCES scoring_policies(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  weights        JSONB NOT NULL,   -- { relevance, audienceQuality, activity, confidence } sums 1
  thresholds     JSONB NOT NULL,   -- { qualifiedMin, reviewMin, rejectMax } 0..100
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);

CREATE TABLE decision_policies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE decision_policy_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id          UUID NOT NULL REFERENCES decision_policies(id) ON DELETE CASCADE,
  version            INTEGER NOT NULL,
  accept_threshold   NUMERIC(5,4) NOT NULL CHECK (accept_threshold BETWEEN 0 AND 1),
  review_threshold   NUMERIC(5,4) NOT NULL CHECK (review_threshold BETWEEN 0 AND 1),
  reject_threshold   NUMERIC(5,4) NOT NULL CHECK (reject_threshold BETWEEN 0 AND 1),
  fallback_threshold NUMERIC(5,4) NOT NULL CHECK (fallback_threshold BETWEEN 0 AND 1),
  use_decision_provider BOOLEAN NOT NULL DEFAULT FALSE,  -- Jev OPTIONAL by policy, not hardwired
  decision_strategy  TEXT NOT NULL DEFAULT 'LLM_ONLY'
                       CHECK (decision_strategy IN
                        ('RULES_ONLY', 'LLM_ONLY', 'DECISION_PROVIDER_ONLY',
                         'LLM_THEN_DECISION_PROVIDER', 'RULES_THEN_LLM', 'RULES_LLM_DECISION_PROVIDER')),
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version),
  CONSTRAINT chk_order_thresholds CHECK
    (accept_threshold >= review_threshold AND review_threshold >= reject_threshold)
);

-- Deferred FK: lead_scores.scoring_policy_version_id → scoring_policy_versions
-- (inline REFERENCES would fail: lead_scores is created in section 7,
--  scoring_policy_versions in section 8).
ALTER TABLE lead_scores ADD CONSTRAINT fk_lead_scores_policy_version
  FOREIGN KEY (scoring_policy_version_id) REFERENCES scoring_policy_versions(id);

-- =====================================================================
-- 9. ENTITY RESOLUTION
-- =====================================================================

CREATE TABLE entity_resolution_candidates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  business_a_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  business_b_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  resolvable_signals JSONB NOT NULL DEFAULT '[]',   -- { signalType, value, similarity }
  similarity   NUMERIC(5,4),
  verdict      match_verdict NOT NULL DEFAULT 'UNCERTAIN',
  status       resolution_status NOT NULL DEFAULT 'PENDING',
  decided_by   TEXT NOT NULL CHECK (decided_by IN ('AI', 'RULES', 'HUMAN', 'PENDING')),
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (business_a_id <> business_b_id),
  UNIQUE (business_a_id, business_b_id)
);

CREATE INDEX idx_erc_pending ON entity_resolution_candidates (tenant_id, status)
  WHERE status = 'PENDING';

CREATE TABLE entity_resolution_matches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES entity_resolution_candidates(id) ON DELETE CASCADE,
  matched_business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,  -- surviving canonical
  match_rule  TEXT NOT NULL,                -- deterministic rules or review
  confidence  NUMERIC(5,4),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entity_merge_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id       UUID REFERENCES entity_resolution_candidates(id) ON DELETE SET NULL,
  merged_from_id     UUID NOT NULL REFERENCES businesses(id),
  merged_into_id     UUID NOT NULL REFERENCES businesses(id),
  merged_by          TEXT NOT NULL,          -- user id / 'SYSTEM'
  merge_reason       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- 10. CAMPAIGNS / REVIEWS
-- =====================================================================

CREATE TABLE campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
  filters     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaign_leads (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, lead_id)
);

CREATE TABLE human_reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  analysis_id        UUID REFERENCES lead_analyses(id) ON DELETE SET NULL,
  reviewer_id        UUID NOT NULL REFERENCES users(id),
  decision           review_decision NOT NULL,
  original_value     JSONB,
  corrected_value    JSONB,
  reason             TEXT,
  model_version      TEXT,
  taxonomy_version   INTEGER,
  scoring_policy_version UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- 11. AI PROVIDER INFRA METADATA
-- =====================================================================

CREATE TABLE ai_providers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('LLM', 'VISION', 'DECISION', 'EMBEDDING', 'OTHER')),
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   UUID NOT NULL REFERENCES ai_providers(id),
  name          TEXT NOT NULL,
  version       TEXT,
  capabilities  JSONB NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name, version)
);

CREATE TABLE ai_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  job_id              UUID,                  -- FK added in section 12
  provider_id         UUID NOT NULL REFERENCES ai_providers(id),
  model_version_id    UUID REFERENCES model_versions(id),
  task_type           TEXT NOT NULL CHECK (task_type IN (
    'CLASSIFICATION', 'EXTRACTION', 'QUERY_PARSING', 'SUMMARIZATION',
    'EVIDENCE_EXTRACTION', 'VISUAL_ANALYSIS', 'DECISION_MAKING')),
  analysis_mode       analysis_mode NOT NULL DEFAULT 'STANDARD',
  input_hash          TEXT,
  output_hash         TEXT,
  status              TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'RETRY', 'TIMEOUT')),
  latency_ms          INTEGER,
  tokens_input        INTEGER,
  tokens_output       INTEGER,
  estimated_cost      NUMERIC(14,6),
  prompt_version      TEXT,
  schema_version      TEXT,
  decision_policy_version_id UUID REFERENCES decision_policy_versions(id),
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_runs_tenant_created ON ai_runs (tenant_id, created_at DESC);

-- =====================================================================
-- 12. JOBS (persistent; Redis/BullMQ is execution, DB is truth)
-- =====================================================================

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  type            TEXT NOT NULL CHECK (type IN (
    'DISCOVERY', 'NORMALIZATION', 'DEDUP', 'ANALYSIS', 'SCORING', 'EXPORT', 'REPROCESS')),
  status          job_status NOT NULL DEFAULT 'PENDING',
  priority        INTEGER NOT NULL DEFAULT 0,
  current_step    job_step,
  payload         JSONB NOT NULL DEFAULT '{}',
  progress        SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  correlation_id  UUID,
  parent_job_id   UUID REFERENCES jobs(id) ON DELETE SET NULL,
  run_after       TIMESTAMPTZ,             -- mirrors BullMQ delay
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no    INTEGER NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  outcome       TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'RETRYABLE_FAILURE', 'FATAL_FAILURE')),
  error_code    TEXT,
  error_message TEXT,
  UNIQUE (job_id, attempt_no)
);

CREATE TABLE job_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('STARTED', 'PROGRESS', 'STATUS', 'FAILED', 'COMPLETED', 'RETRY_SCHEDULED', 'CANCEL_REQUESTED')),
  payload    JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_tenant_status ON jobs (tenant_id, status, priority DESC);
CREATE INDEX idx_jobs_correlation ON jobs (correlation_id);
ALTER TABLE ai_runs ADD CONSTRAINT fk_ai_runs_job FOREIGN KEY (job_id) REFERENCES jobs(id);
ALTER TABLE decisions ADD CONSTRAINT fk_decisions_policy_version
  FOREIGN KEY (decision_policy_version_id) REFERENCES decision_policy_versions(id);

-- =====================================================================
-- 13. EXPORTS / IDEMPOTENCY / USAGE / AUDIT
-- =====================================================================

CREATE TABLE exports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  job_id         UUID REFERENCES jobs(id),
  export_type    TEXT NOT NULL CHECK (export_type IN ('CSV', 'JSON', 'XLSX')),
  campaign_id    UUID REFERENCES campaigns(id),
  filters        JSONB NOT NULL DEFAULT '{}',
  file_url       TEXT,                        -- populated by export job
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  scope              TEXT NOT NULL CHECK (scope <> ''),   -- e.g. 'POST /discovery/search'
  idempotency_key    TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  response_snapshot  JSONB,                               -- replayed on retry-with-same-key
  status             TEXT NOT NULL DEFAULT 'IN_FLIGHT' CHECK (status IN ('IN_FLIGHT', 'COMPLETED', 'FAILED')),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, idempotency_key)
);

CREATE TABLE usage_counters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  period      TEXT NOT NULL,               -- '2026-10'
  metric      TEXT NOT NULL CHECK (metric IN ('LEADS_DISCOVERED', 'AI_CALLS', 'VISION_CALLS', 'DECISION_CALLS', 'IMAGES_ANALYZED', 'EXPORTS', 'ESTIMATED_COST')),
  value       NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, metric)
);

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  actor_id    UUID REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id   UUID,
  action      TEXT NOT NULL,
  before_json JSONB,
  after_json  JSONB,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);

COMMIT;

-- =====================================================================
-- INDEX STRATEGY — see docs/database/INDEX-AND-QUERY-STRATEGY.md
-- Lead list filtering by current score uses the partial index
-- idx_leads_scores_current_filters; no ad-hoc query semantics required.
-- =====================================================================
