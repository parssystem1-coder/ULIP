# Database / ERD Specification

Canonical schema: `database/schema/schema.sql` (snapshot) generated from
`database/migrations/` (authoritative — see MIGRATION-AND-VERSIONING.md).
This document is the readable companion; when artifacts disagree, the
migration source wins.

## 1. Core Entities

```text
Tenant
User
Source
SourceAccount
RawEntity (+ RawEntityCurrent)
Business
BusinessLocation
BusinessContact
Lead
LeadIdentity
LeadContent
TaxonomyNode (+ Translations + Aliases)
NormalizationRule
LocationAlias
LeadClassification
LeadAnalysis
Evidence
LeadScore
AudienceQuality
Decision
EntityResolutionCandidate / Match / MergeEvent
HumanReview
Campaign
CampaignLead
AIProvider
ModelVersion
AIRun
Job / JobAttempt / JobEvent
Export
IdempotencyKey
UsageCounter
ScoringPolicy / ScoringPolicyVersion
DecisionPolicy / DecisionPolicyVersion
AuditLog
SocialAction / SocialActionAttempt   (migration 0002, ADR-026)
MessageTemplate                       (migration 0002, ADR-026)
OutreachCampaign / OutreachRecipient  (migration 0002, ADR-026)
LeadContactHistory                    (migration 0002, ADR-026)
SuppressionEntry                      (migration 0002, ADR-026)
```

Lifecycle values (leads.status and every workflow status) are Postgres enums —
see the ENUMS section of schema.sql. The canonical processing state machine is
defined in `docs/architecture/ORCHESTRATION.md` (ADR-016).

---

# 2. ERD

```text
Tenant
 │
 ├────────────── Users
 │
 ├────────────── Sources
 │                  │
 │                  └── SourceAccounts
 │
 ├────────────── Businesses
 │                  │
 │                  └── Leads
 │                       │
 │       ┌───────────────┼─────────────────┐
 │       ↓               ↓                 ↓
 │ LeadIdentity     LeadContent       LeadAnalysis
 │                                       │
 │                                       ↓
 │                                  Classification
 │
 ├── Taxonomy
 │
 ├── Evidence
 │
 ├── LeadScores
 │
 ├── AudienceQuality
 │
 ├── HumanReviews
 │
 └── Campaigns
```

---

# 3. tenants

```sql
id
name
status
created_at
updated_at
```

---

# 4. users

```sql
id
tenant_id
email
name
role
status
created_at
updated_at
```

---

# 5. sources

```sql
id
tenant_id
type
name
status
config
created_at
updated_at
```

Example:

```text
type = INSTAGRAM
```

---

# 6. source_accounts

```sql
id
source_id
external_account_id
display_name
status
metadata
created_at
updated_at
```

---

# 7. raw_entities (immutable snapshots)

```sql
id
source_id
external_id
entity_type
payload_json
content_hash
revision
ingest_status
collected_at
created_at
```

Identity vs observation vs snapshot:
- **entity identity** = (source_id, external_id) — deduplication key for leads;
- **raw observation** = one retrieval event (collected_at);
- **raw snapshot** = (source_id, external_id, content_hash) — UNIQUE: identical
  payloads collapse regardless of collection time; changed payloads create a
  new snapshot version (history preserved).

`raw_entity_currents` holds the latest snapshot pointer per identity.

---

# 8. businesses (+ locations, contacts)

```sql
id
tenant_id
canonical_name
description
business_type_node_id   -- FIRST-CLASS Business Type (ADR-018)
industry_node_id
website
status
created_at
updated_at
```

`business_locations` carries structured, provenance-aware location
(country/province/city/district, raw_value, availability, confidence, source).
`business_contacts` carries typed contact channels (PHONE/MOBILE/WHATSAPP/
EMAIL/WEBSITE/SOCIAL) with normalized values, availability, confidence and
`is_sensitive` for privacy-restricted exposure (PII-DATA-MODEL.md).

---

# 9. leads

```sql
id
tenant_id
business_id
status
first_seen_at
last_seen_at
created_at
updated_at
```

---

# 10. lead_identities

```sql
id
lead_id
source_id
external_id
username
profile_url
display_name
metadata
created_at
updated_at
```

Unique:

```text
source_id + external_id
```

---

# 11. lead_contents

```sql
id
lead_id
source_content_id
content_type   -- TEXT | IMAGE | VIDEO | LINK | METADATA | POST | REEL | CAROUSEL (0005)
text
media_url
published_at
metadata
content_hash
retrieved_at
created_at
```

Content is a first-class analysis input (Phase 18, ADR-030): connector payload
`posts`/`media`/`contents` arrays are ingested with deterministic ids and a
sha256 content hash; the UNIQUE `(lead_id, source_content_id, content_hash)`
constraint keeps history immutable — a changed caption appends a NEW version
row, a repeat inserts nothing.

---

# 11b. content_analyses + content_analysis_items (migration 0005, Phase 18, ADR-030)

```sql
content_analyses            one VERSIONED content-intelligence result per lead run
  id                        deterministic uuid5(job, lead) — idempotent replay
  lead_id, analysis_id      FK → leads / lead_analyses
  analysis_version, analysis_mode
  sampling                  JSONB strategy record (depth, considered, budget,
                            selected[] with per-item reasons + evidenceId, skipped[])
  profile_content_consistency  AGREE | PARTIAL | CONFLICT | INSUFFICIENT_CONTENT
  consistency_confidence    0..1
  activity_signals          JSONB recency/cadence/recentCount (content-derived;
                            never follower-only claims)
  content_relevance         0..1 | NULL (NULL when no criteria supplied)
  relevance_criteria        the requested search criteria, when provided
  review_reasons            JSONB [PROFILE_CONTENT_CONFLICT, INSUFFICIENT_CONTENT,
                            WEAK_EVIDENCE, MODALITY_UNAVAILABLE, TAXONOMY_AMBIGUITY]
  is_current / superseded_at  current-version semantics (partial unique index,
                            exactly one current row per lead); history preserved

content_analysis_items      per-sampled-item outcome of one version
  (content_analysis_id, lead_content_id) UNIQUE
  selected_reasons          RECENCY | REPRESENTATIVE | HIGH_SIGNAL | TYPE_DIVERSITY
                            | ONLY_AVAILABLE
  text/image/media_analyzed honest per-modality flags
  modality_notes            e.g. {"vision": "UNAVAILABLE"} — missing modalities
                            are recorded, never fabricated; video = METADATA_ONLY
  relevance, relevance_signals, topics
```

A separate `ai_runs` row with `task_type='VISUAL_ANALYSIS'` is written when a
Vision step actually ran (provider/model/prompt/schema versions stamped).

---

# 12. taxonomy_nodes (+ i18n)

```sql
id
tenant_id
parent_id
node_kind   -- BUSINESS_TYPE | INDUSTRY | SPECIALTY | SUB_SPECIALTY (enum)
name
slug
description
status
version
created_at
updated_at
```

Constraints:
- roots: `UNIQUE (tenant_id, slug)` via partial index `uniq_taxonomy_root_slug`
  (NULL parent is invisible to the composite UNIQUE — remediation §15);
- children: `UNIQUE (tenant_id, parent_id, slug)`;
- hierarchy edges enforced by `chk_taxonomy_parent_kind` trigger
  (BT→I→S→SS only).

`taxonomy_node_translations` (locale, name) and `taxonomy_node_aliases`
(alias, alias_norm, locale) provide Persian-first display and resolution
(ADR-019). `normalization_rules` and `location_aliases` are data-driven
normalization/geo mapping.

---

# 13. lead_classifications

```sql
id
lead_id
analysis_id
classification_type  -- BUSINESS_TYPE | INDUSTRY | SPECIALTY | SUB_SPECIALTY | BRAND | OTHER (enum)
taxonomy_node_id
value_text
value_normalized
confidence
source
model_version
created_at
```

Business Type is a classification type of its own (ADR-018).
BRAND carries free values (e.g. "HP") via value_text when no node exists.

---

# 14. lead_analyses (current-version semantics, ADR-024)

```sql
id
lead_id
analysis_version
model_version
prompt_version
schema_version
taxonomy_version
analysis_mode    -- BASIC | STANDARD | DEEP | BE_REUSE
summary
structured_output
confidence
is_current
superseded_at
created_at
```

Exactly one `is_current = TRUE` row per lead (partial unique index
`uniq_leads_analysis_current`). Evidence is written inside the analysis
transaction BEFORE the new row becomes current; `evidence.analysis_id`
makes orphan references impossible.

**Who writes it (Phase 16, ADR-028).** `@ulip/analysis` `DbAnalysisStore`
(`blueprint/packages/analysis/src/store.ts`) — and only it. Ids are derived
from `job_id`/`lead_id`, so a retried job rewrites the same row instead of
inserting a second current one. Superseding (`is_current = FALSE`,
`superseded_at = now()`) happens in the same transaction as the new current
insert. Readers: `GET /leads/{leadId}/analysis` (API) — tenant-scoped.

---

# 15. evidence

```sql
id
lead_id
evidence_type
source_type
source_reference
content
metadata
confidence
created_at
```

---

# 16. lead_scores (current semantics + policy version, ADR-021/024)

```sql
id
lead_id
scoring_policy_version_id
relevance_score
audience_quality_score
activity_score
confidence_score
priority_score
is_current
superseded_at
created_at
```

All five dimensions are written together per analysis run, each with the
`scoring_policy_version_id` (ACTIVE version resolved by `@ulip/scoring`
`resolvePolicy()`) that produced them. Thresholds are read from that persisted
policy — never from application code. Exactly one `is_current = TRUE` row per
lead, same supersession rule as `lead_analyses`.

Exactly one current score per lead; the list filter
`GET /leads?minRelevance=` queries the partial index
`idx_leads_scores_current_filters` directly.

---

# 17. audience_quality

```sql
id
lead_id
quality_score
risk_level
signals
confidence
model_version
created_at
```

---

# 18. decisions

```sql
id
lead_id
decision_type
options
selected_option
probabilities
threshold
status
provider
model_version
created_at
```

---

# 19. human_reviews

```sql
id
lead_id
reviewer_id
decision
original_value
corrected_value
reason
created_at
```

---

# 20. campaigns

```sql
id
tenant_id
name
description
status
filters
created_at
updated_at
```

---

# 21. campaign_leads

```sql
campaign_id
lead_id
status
added_at
```

Composite Primary Key:

```text
campaign_id + lead_id
```

---

# 22. ai_providers

```sql
id
name
type
status
config
created_at
updated_at
```

---

# 23. model_versions

```sql
id
provider_id
name
version
capabilities
status
created_at
```

---

# 24. ai_runs

```sql
id
tenant_id
lead_id
provider_id
model_version_id
task_type
input_hash
output_hash
status
latency_ms
tokens_input
tokens_output
estimated_cost
error
created_at
```

---

# 25. audit_logs

```sql
id
tenant_id
actor_id
entity_type
entity_id
action
before_json
after_json
metadata
created_at
```

---

# 28. Social Actions / Outreach (migration 0002, ADR-026)

```sql
social_actions
id, tenant_id, lead_id, source_type, type, status, idempotency_key,
external_id, profile_url, rendered_message, campaign_id, template_id,
actor_id, error_code, error_message, executed_at, manual_completed_at,
created_at, updated_at
-- idempotency: UNIQUE (tenant_id, idempotency_key)
```

`social_action_attempts`: یک ردیف به‌ازای هر فراخوانی provider
(attempt_no، outcome، error_code، **retry_after_at** — محترم شمرده می‌شود،
هرگز دور زده نمی‌شود، provider_ref، started_at/finished_at).

`message_templates`: نام/بدنه با `{{placeholders}}`، variables، status،
version — UNIQUE (tenant_id, name).

`outreach_campaigns`: filters (همان مدل جهانی Business Type → Industry →
Specialty → Sub-specialty + Location)، template_id، status با gate تأیید
انسانی (DRAFT → PENDING_APPROVAL → APPROVED → EXECUTING → …)، job_id ارجاع به
job نوع OUTREACH.

`outreach_recipients`: **یک ردیف به‌ازای (campaign_id, lead_id) = یک پیام
جداگانه برای هر lead — هرگز group chat نیست.** status شامل SENT/FAILED/
SKIPPED با ineligibility_reason؛ retry-safe (SENT هرگز دوباره ارسال
نمی‌شود).

`lead_contact_history`: تاریخچه تماس (channel/direction/occurred_at) برای
guard فاصلهٔ تماس و گزارش.

`suppression_entries`: ممنوع‌التماس (scope: LEAD/BUSINESS/EMAIL/PHONE/DOMAIN)؛
**همیشه برنده است** — lead ممنوع‌التماس هرگز تماس نمی‌گیرد.

---

# 29. Index Strategy

ضروری:

```text
leads(tenant_id, status)
lead_identities(source_id, external_id)
lead_classifications(taxonomy_node_id)
lead_scores(priority_score)
lead_scores(relevance_score)
lead_scores(activity_score)
evidence(lead_id)
lead_contents(lead_id, published_at)
ai_runs(tenant_id, created_at)
audit_logs(tenant_id, created_at)
social_actions(tenant_id, status, created_at DESC)
social_actions(tenant_id, lead_id, created_at DESC)
social_action_attempts(tenant_id, action_id)
outreach_campaigns(tenant_id, status, created_at DESC)
outreach_recipients(tenant_id, campaign_id, status)
lead_contact_history(tenant_id, lead_id, occurred_at DESC)
suppression_entries(tenant_id, scope, lead_id, business_id)
```

---

# 27. JSONB Usage

JSONB فقط برای داده‌هایی که ذاتاً Dynamic هستند.

```text
raw_entities.payload_json
lead_analyses.structured_output
sources.config
scoring_policy_versions.weights / thresholds
decisions.decision_options / probabilities
entity_resolution_candidates.resolvable_signals
campaigns.filters
outreach_campaigns.filters
message_templates.variables
```

اطلاعات اصلی و Queryable نباید بی‌دلیل داخل JSONB قرار گیرند.

---

# 28. Data Versioning

برای Analysis:

```text
analysis_version
model_version
taxonomy_version
scoring_version
```

ثبت شود.

---

# 29. AI Evaluation (migration 0004, Phase 17, ADR-029)

```text
evaluation_runs            deterministic run id = uuid5(tenant, dataset_version,
                           arm, provider, model, prompt_version, schema_version,
                           taxonomy_version, scoring_policy_version)
evaluation_case_results    per-case rows (exact_match, dimension_accuracy,
                           mean_confidence, error_category, outcome,
                           latency_ms, tokens, detail JSONB)
evaluation_corrections     human corrections, append-only
                           (tenant_id, dataset_version, case_id, field,
                            reviewer_id) UNIQUE NULLS NOT DISTINCT
```

- All three tables are **tenant-scoped**; runs/case-results are
  **append-only** (trigger `ulip_reject_evaluation_mutation` rejects
  UPDATE/DELETE — a mutable measurement is worthless as a baseline).
- `ai_runs` is NOT duplicated: an evaluation run is a measurement over a
  frozen dataset, not a per-lead provider call.
- Re-running the same evaluation converges on the same row
  (`uniq_evaluation_runs_identity` + deterministic id) instead of duplicating.
- Corrections never overwrite AI output; reviewer disagreement is another row
  (NULLS NOT DISTINCT keeps anonymous corrections unique too).
- Re-apply note: 0004 was re-applied on the dev database after switching the
  corrections unique constraint to `NULLS NOT DISTINCT` (PG 15+).
