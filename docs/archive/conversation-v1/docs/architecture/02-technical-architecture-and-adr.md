# Technical Architecture & Architecture Decision Records

## 1. Architecture Goal

هدف معماری:

- Modular
- Extensible
- Provider-Agnostic
- AI-Native
- Multi-Source
- Auditable
- Observable
- Scalable

---

# 2. Architectural Style

### انتخاب

**Modular Monolith**

نه Microservices.

دلیل:

- توسعه سریع‌تر
- Debug آسان‌تر
- Deployment ساده‌تر
- Transactionهای ساده‌تر
- مناسب MVP
- امکان استخراج Service در آینده

---

# 3. Technology Stack

## Frontend

```text
Next.js
React
TypeScript
Tailwind CSS
```

## Backend

```text
NestJS
TypeScript
```

## Database

```text
PostgreSQL
JSONB
```

## Queue

```text
Redis
BullMQ
```

## Object Storage

```text
S3-compatible
```

## Observability

```text
OpenTelemetry
```

---

# 4. System Architecture

```text
                  ┌───────────────┐
                  │    Next.js    │
                  └───────┬───────┘
                          │
                          ↓
                  ┌───────────────┐
                  │   NestJS API  │
                  └───────┬───────┘
                          │
          ┌───────────────┼────────────────┐
          ↓               ↓                ↓
       Sources       Intelligence       Campaigns
          │               │                │
          ↓               ↓                ↓
      Connectors      AI Gateway         Export
                          │
              ┌───────────┼────────────┐
              ↓           ↓            ↓
             LLM        Vision        Jev
```

---

# 5. Core Modules

```text
auth
users
tenants
sources
connectors
discovery
raw-data
normalization
deduplication
leads
taxonomy
content
analysis
ai
decisions
evidence
scoring
audience
reviews
campaigns
exports
usage
audit
```

---

# ADR-001 — Modular Monolith

### Decision

Use Modular Monolith.

### Reason

MVP complexity باید کنترل شود.

### Future

هر Module در صورت نیاز قابل استخراج به Service مستقل باشد.

---

# ADR-002 — PostgreSQL

### Decision

PostgreSQL Database اصلی باشد.

### Reason

- Relational integrity
- JSONB
- Indexing
- Transactions
- Mature ecosystem

---

# ADR-003 — Redis + BullMQ

### Decision

Jobهای سنگین از طریق Queue اجرا شوند.

### Jobs

```text
discovery
normalization
analysis
vision
decision
scoring
export
```

---

# ADR-004 — Provider Abstraction

هیچ Provider خارجی نباید مستقیماً در Domain استفاده شود.

به‌جای:

```typescript
AnthropicClient
```

در Domain:

```typescript
interface LLMProvider {
   ...
}
```

استفاده شود.

---

# ADR-005 — Connector Architecture

هر Source یک Connector مستقل دارد.

```typescript
interface LeadSourceConnector {
  metadata(): SourceMetadata;

  search(
    request: DiscoveryRequest
  ): Promise<DiscoveryResult>;

  fetch(
    identifier: string
  ): Promise<RawEntity | null>;

  healthCheck(): Promise<HealthStatus>;
}
```

---

# ADR-006 — AI Gateway

AI Gateway واسط بین Domain و Providerهای AI است.

```text
Domain
 ↓
AI Gateway
 ↓
Provider Adapter
 ↓
External AI
```

---

# ADR-007 — LLM / Jev Separation

LLM:

```text
Understanding
Extraction
Reasoning
```

Jev:

```text
Bounded Decision
Classification
Routing
```

Code:

```text
Deterministic Business Rules
```

---

# ADR-008 — Evidence First

هر Prediction مهم باید Evidence داشته باشد.

```text
Prediction
↓
Evidence
↓
Confidence
```

---

# ADR-009 — Human-in-the-Loop

AI نتیجه نهایی غیرقابل تغییر نیست.

Human Review باید بخشی از Domain باشد.

---

# ADR-010 — Scoring Separation

Scoreها مستقل نگه داشته شوند:

```text
Relevance
Audience Quality
Activity
Confidence
Priority
```

هیچ‌کدام جای دیگری را نمی‌گیرد.

---

# ADR-011 — Dynamic Taxonomy

Taxonomy نباید داخل Code Hardcode شود.

در Database نگهداری می‌شود.

---

# ADR-012 — Raw Data Preservation

Raw Data قبل از Normalization نگهداری شود.

هدف:

- Debug
- Reprocessing
- Auditing
- Model Improvement

---

# ADR-013 — No Automatic Outreach in Core

Outreach از Intelligence جدا است.

اگر در آینده اضافه شود:

```text
Outreach Module
```

خواهد بود.

---

# ADR-014 — No GNN in MVP

GNN به Phase بعد منتقل می‌شود.

دلیل:

- نیاز به Graph Data
- Complexity
- نیاز به Dataset
- عدم ضرورت برای MVP

---

# ADR-015 — PARSE Later

MVP:

```text
Structured Schema
+
Validation
+
Grounding
```

نسخه‌های بعد:

```text
Schema Optimization
+
Reflection
+
Adaptive Retry
```

---

# 6. Domain Flow

```text
Discovery
 ↓
RawEntity
 ↓
Normalization
 ↓
Entity Resolution
 ↓
Lead
 ↓
Analysis
 ↓
Evidence
 ↓
Decision
 ↓
Score
 ↓
Review
 ↓
Campaign
```

---

# 7. Source Layer

```text
Source
SourceAccount
Connector
DiscoveryJob
RawEntity
```

Source صرفاً مشخص می‌کند داده از کجا آمده است.

---

# 8. AI Domain

```text
AIRequest
AIResponse
AIProvider
ModelVersion
AIUsage
AIError
```

هر AI Run باید قابل ردیابی باشد.

---

# 9. Decision Architecture

```text
Candidate Options
       ↓
Decision Provider
       ↓
Probability Distribution
       ↓
Application Threshold
       ↓
Accept / Review / Reject
```

Decision Provider نباید Workflow را مالک شود.

---

# 10. Scoring Engine

```typescript
interface ScoringEngine {
  calculate(
    lead: Lead,
    context: ScoringContext
  ): Promise<LeadScores>;
}
```

فرمول‌ها باید Configuration باشند.

---

# 11. Evidence Architecture

Evidence Types:

```text
BIO_TEXT
CAPTION_TEXT
IMAGE
CONTENT_METADATA
LOCATION
ENGAGEMENT
PROFILE_METADATA
MODEL_INFERENCE
HUMAN_CORRECTION
```

---

# 12. Confidence

Confidence باید جدا از Score باشد.

مثلاً:

```text
Relevance = 94
Confidence = 61
```

یعنی نتیجه مرتبط به نظر می‌رسد، اما سیستم اطمینان زیادی ندارد.

---

# 13. Job Architecture

```text
Queue
 ├── discovery
 ├── normalization
 ├── deduplication
 ├── analysis
 ├── vision
 ├── decision
 ├── scoring
 └── export
```

هر Job:

- idempotent
- retryable
- observable
- timeout-controlled

باشد.

---

# 14. Error Handling

Error Categories:

```text
CONNECTOR_ERROR
RATE_LIMITED
DATA_UNAVAILABLE
INVALID_DATA
AI_PROVIDER_ERROR
SCHEMA_VALIDATION_ERROR
TIMEOUT
UNKNOWN
```

---

# 15. Retry

Retry فقط برای خطاهای قابل retry.

مثلاً:

```text
Timeout → Retry
Temporary Provider Error → Retry
Invalid Schema → Repair/Retry
Authentication Error → No Retry
Permission Error → No Retry
```

---

# 16. Security Architecture

- Authentication
- Authorization
- Tenant isolation
- Secret management
- Input validation
- Output validation
- Audit logging
- Encryption in transit
- Least privilege

---

# 17. Multi-Tenant Readiness

حتی اگر MVP Single Tenant باشد، Domain باید قابلیت Tenant را در نظر بگیرد.

```text
tenant_id
```

در Entityهای اصلی وجود داشته باشد.

---

# 18. Observability

Trace:

```text
API
 ↓
Job
 ↓
Connector
 ↓
AI
 ↓
Database
```

هر عملیات مهم باید Correlation ID داشته باشد.

---

# 19. Future Microservice Boundaries

در آینده قابل استخراج:

```text
Discovery Service
AI Service
Analysis Service
Export Service
Connector Workers
```

اما فقط در صورت نیاز واقعی.

---

# 20. Architecture Quality Goals

هدف MVP:

```text
Maintainability: High
Extensibility: High
Complexity: Controlled
Observability: High
AI Replaceability: High
Provider Lock-in: Low
```
