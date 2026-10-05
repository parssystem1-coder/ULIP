# Database / ERD Specification

## 1. Core Entities

```text
Tenant
User
Source
SourceAccount
RawEntity
Business
Lead
LeadIdentity
LeadContent
TaxonomyNode
LeadClassification
LeadAnalysis
Evidence
LeadScore
AudienceQuality
Decision
HumanReview
Campaign
CampaignLead
AIProvider
ModelVersion
AIRun
AIUsage
AuditLog
```

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

# 7. raw_entities

```sql
id
source_id
external_id
entity_type
payload_json
content_hash
collected_at
created_at
```

Unique:

```text
source_id + external_id
```

---

# 8. businesses

```sql
id
tenant_id
canonical_name
description
city
country
website
status
created_at
updated_at
```

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
content_type
text
media_url
published_at
metadata
content_hash
created_at
```

---

# 12. taxonomy_nodes

```sql
id
tenant_id
parent_id
name
slug
description
status
version
created_at
updated_at
```

---

# 13. lead_classifications

```sql
id
lead_id
taxonomy_node_id
classification_type
confidence
source
model_version
created_at
```

مثلاً:

```text
classification_type = PROFESSION
classification_type = SPECIALTY
```

---

# 14. lead_analyses

```sql
id
lead_id
analysis_version
model_version
summary
structured_output
confidence
created_at
```

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

# 16. lead_scores

```sql
id
lead_id
relevance_score
audience_quality_score
activity_score
confidence_score
priority_score
scoring_version
created_at
```

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

# 26. Index Strategy

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
```

---

# 27. JSONB Usage

JSONB فقط برای داده‌هایی که ذاتاً Dynamic هستند.

مثلاً:

```text
raw_entities.payload_json
lead_analyses.structured_output
source.config
ai_runs.metadata
```

اطلاعات اصلی و Queryable نباید بی‌دلیل داخل JSONB قرار گیرد.

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
