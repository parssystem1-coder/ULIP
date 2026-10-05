# ERD Specification

```text
Tenant 1 ───── * User
Tenant 1 ───── * Source
Source 1 ───── * SourceAccount
Source 1 ───── * RawEntity
Tenant 1 ───── * Business
Business 1 ─── * Lead
Lead 1 ─────── * LeadIdentity
Lead 1 ─────── * LeadContent
Lead 1 ─────── * LeadClassification
TaxonomyNode 1 ── * TaxonomyNode
Lead 1 ─────── * LeadAnalysis
Lead 1 ─────── * Evidence
Lead 1 ─────── * LeadScore
Lead 1 ─────── 1 AudienceQuality (versioned rows may be historical in a later revision)
Lead 1 ─────── * Decision
Lead 1 ─────── * HumanReview
Tenant 1 ───── * Campaign
Campaign * ─── * Lead (via CampaignLead)
AIProvider 1 ─ * ModelVersion
AIProvider 1 ─ * AIRun
ModelVersion 1 ─ * AIRun
Tenant 1 ───── * AIRun
Tenant 1 ───── * Job
Job 1 ───────── * JobAttempt
Job 1 ───────── * JobEvent
Job * ───────── 1 Job (parent_job_id: pipeline sub-jobs)
Business 1 ──── * BusinessContact
Business 1 ──── * BusinessLocation
TaxonomyNode 1 ─ * TaxonomyNodeTranslation
TaxonomyNode 1 ─ * TaxonomyNodeAlias
Location 1 ───── * LocationAlias
Tenant 1 ───── * ScoringPolicy → ScoringPolicyVersion
Tenant 1 ───── * DecisionPolicy → DecisionPolicyVersion
Lead 1 ─────── * EntityResolutionCandidate (candidate A/B, signals, similarity)
EntityResolutionMatch * ── * Business / Lead (merge decisions via EntityMergeEvent)
Tenant 1 ───── * AuditLog
-- Social Actions + Outreach (migration 0002, ADR-026)
Tenant 1 ───── * MessageTemplate
Tenant 1 ───── * OutreachCampaign        (filters keep the universal business model)
MessageTemplate 1 ── * OutreachCampaign
Tenant 1 ───── * SocialAction
Lead 1 ─────── * SocialAction            (UNIQUE (tenant_id, idempotency_key))
SocialAction 1 ── * SocialActionAttempt (retry-after persisted, respected)
OutreachCampaign 1 ── * OutreachRecipient (one row per (campaign, lead) = one separate message)
OutreachRecipient * ── 1 SocialAction
Lead 1 ─────── * LeadContactHistory      (cool-down guard + reporting)
Tenant 1 ───── * SuppressionEntry        (always wins; scoped LEAD/BUSINESS/EMAIL/PHONE/DOMAIN)
```

Current-version semantics (ADR-024): `lead_analyses` and `lead_scores` keep
versioned rows per lead; exactly one row per lead carries `is_current = true`
(enforced by partial unique indexes), so `GET /leads?minRelevance=80` filters on
current scores directly. Lifecycle states on `leads.status` are DB-enforced
(CHECK constraints) per ADR-016.

The full table inventory with column-level definitions lives in
`docs/database/DATABASE.md` and `docs/database/DATA-DICTIONARY.md`; the
authoritative DDL is `database/migrations/` (snapshot: `database/schema/schema.sql`).

```text
Business
  ├── Lead
  │     ├── Source Identity A
  │     ├── Source Identity B
  │     ├── Content
  │     ├── Analyses
  │     ├── Evidence
  │     ├── Scores
  │     └── Reviews
  └── Website/phone/location signals
```

The Business entity represents the canonical real-world entity; Lead is the tenant/workflow-facing prospect record.
