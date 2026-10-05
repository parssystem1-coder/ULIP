# MASTER IMPLEMENTATION PROMPT
## Universal Lead Intelligence Platform

You are the principal software architect and senior implementation engineer responsible for implementing the Universal Lead Intelligence Platform.

Do NOT treat this project as an Instagram scraper.

The product is a provider-agnostic Universal Lead Intelligence Platform.

Instagram is only the first data source.

---

# 1. PRIMARY OBJECTIVE

Build a production-grade modular monolith capable of:

1. Discovering leads from supported sources.
2. Normalizing source-specific data.
3. Resolving duplicate identities.
4. Creating a universal Lead model.
5. Managing dynamic taxonomy.
6. Analyzing structured text.
7. Performing multimodal analysis when permitted data is available.
8. Using configurable AI providers.
9. Using Jev as a bounded decision provider where appropriate.
10. Generating explainable evidence.
11. Calculating Lead Relevance.
12. Calculating Audience Quality.
13. Calculating Business Activity.
14. Calculating Data Confidence.
15. Calculating Overall Priority.
16. Supporting Human-in-the-Loop review.
17. Learning from human corrections through an evaluation/feedback dataset.
18. Creating campaigns.
19. Exporting leads.
20. Tracking AI usage, latency and cost.
21. Remaining independent of any specific AI provider or data source.

---

# 2. NON-NEGOTIABLE ARCHITECTURAL RULES

Never violate these rules.

## Rule 1

The Domain Core must not depend directly on Instagram.

Bad:

```typescript
if (source === "instagram") {
   ...
}
```

Good:

```typescript
interface LeadSourceConnector {
   ...
}
```

---

## Rule 2

The Domain Core must not depend directly on a specific AI provider.

Bad:

```typescript
import AnthropicClient from "...";
```

Good:

```typescript
interface LLMProvider {
   ...
}
```

---

## Rule 3

LLM, Vision and Jev are separate capabilities.

LLM:

```text
Understanding
Extraction
Reasoning
```

Vision:

```text
Visual Understanding
```

Jev:

```text
Bounded Decision
Classification
Routing
```

Code:

```text
Deterministic Rules
Workflow
Thresholds
Validation
```

---

## Rule 4

AI predictions must not be treated as ground truth.

Every important AI classification must have:

```text
value
confidence
evidence
modelVersion
timestamp
```

---

## Rule 5

Lead Relevance and Audience Quality must remain separate.

Never merge them into one opaque score.

---

## Rule 6

Do not implement GNN in MVP.

Create architecture boundaries that allow it later.

---

## Rule 7

Do not implement automatic mass outreach.

Core product ends at Lead Intelligence, Campaign and Export.

---

## Rule 8

Do not implement mechanisms intended to bypass platform security, CAPTCHA, anti-bot systems, rate limits, authentication controls or access restrictions.

Connector implementations must use permitted/authorized data access.

---

# 3. TECHNOLOGY

Use:

```text
Frontend:
Next.js
React
TypeScript

Backend:
NestJS
TypeScript

Database:
PostgreSQL

Queue:
Redis
BullMQ

Object Storage:
S3-compatible

Validation:
Zod and/or class-validator according to project conventions

API:
REST + OpenAPI

Observability:
OpenTelemetry
```

Use a modular monolith.

Do not introduce microservices unless explicitly requested.

---

# 4. PROJECT STRUCTURE

Prefer:

```text
apps/
  web/
  api/

packages/
  domain/
  shared/
  ai/
  connectors/
  taxonomy/
  scoring/
  evidence/
```

Backend:

```text
src/modules/

auth/
tenants/
sources/
connectors/
discovery/
raw-data/
normalization/
deduplication/
leads/
taxonomy/
content/
analysis/
ai/
decisions/
evidence/
scoring/
audience/
reviews/
campaigns/
exports/
usage/
audit/
```

Keep module boundaries explicit.

---

# 5. DEVELOPMENT METHOD

DO NOT implement the whole system in one pass.

Use phases.

For every phase:

1. Inspect current repository.
2. Identify existing architecture.
3. Do not overwrite working code unnecessarily.
4. Create/update documentation.
5. Implement the smallest coherent increment.
6. Run type checking.
7. Run lint.
8. Run unit tests.
9. Run integration tests where applicable.
10. Review architecture.
11. Report completed work.
12. Report unresolved issues.
13. Only then continue.

---

# 6. PHASE 0 — REPOSITORY AUDIT

Before changing code:

Inspect:

```text
package.json
tsconfig
apps
packages
src
database
Docker
environment
tests
README
```

Determine:

- existing framework
- existing modules
- database setup
- migration system
- authentication
- testing framework
- linting
- formatting
- deployment configuration

Do NOT assume an empty repository.

If an existing architecture is already present, preserve compatible work.

Output an Architecture Audit before implementation.

---

# 7. PHASE 1 — FOUNDATION

Implement:

```text
Configuration
Database
Logging
Error Handling
Request IDs
Authentication Boundary
Tenant Boundary
Audit Boundary
```

Create:

```text
Health Check
Readiness Check
```

Add:

```text
Docker development environment
```

if missing.

---

# 8. PHASE 2 — DOMAIN MODEL

Implement:

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

Create database migrations.

Add indexes and unique constraints.

Do not put core relational data unnecessarily into JSONB.

---

# 9. PHASE 3 — TAXONOMY

Implement dynamic hierarchical taxonomy.

Required features:

```text
create
update
delete
move
activate
deactivate
list
tree
```

Support:

```text
Profession
Specialty
Sub-specialty
```

Example:

```text
Beauty
 └── Hair
      ├── Hair Coloring
      ├── Balayage
      └── Keratin
```

Do not hardcode these examples into business logic.

Seed data may exist, but taxonomy must remain database-driven.

---

# 10. PHASE 4 — SOURCE SYSTEM

Create:

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

Create:

```text
SourceManager
ConnectorRegistry
ConnectorFactory
```

The Core must communicate with connectors only through interfaces.

---

# 11. PHASE 5 — FIRST CONNECTOR

Implement the first permitted/authorized source connector.

Do not hardcode source-specific assumptions into Lead domain models.

The connector must:

1. Discover available entities.
2. Return RawEntity.
3. Preserve source identity.
4. Report unavailable fields honestly.
5. Handle errors.
6. Respect source access constraints.
7. Support retries only where appropriate.

Never implement anti-bot bypass logic.

---

# 12. PHASE 6 — RAW DATA

Create:

```text
RawEntityRepository
```

Store:

```text
source
externalId
entityType
payload
contentHash
collectedAt
```

Raw data must be immutable or versioned.

---

# 13. PHASE 7 — NORMALIZATION

Create:

```text
Normalizer
```

Responsibilities:

```text
normalize name
normalize location
normalize category
normalize identity
normalize content metadata
```

Output:

```text
NormalizedLeadCandidate
```

Do not let Normalizer perform AI classification.

---

# 14. PHASE 8 — ENTITY RESOLUTION

Implement duplicate detection.

First deterministic signals:

```text
source + externalId
website
normalized phone where legally available
canonical profile URL
```

Then allow future semantic resolution.

Never automatically merge uncertain entities without confidence/review rules.

---

# 15. PHASE 9 — AI GATEWAY

Create:

```typescript
interface LLMProvider {}
interface VisionProvider {}
interface DecisionProvider {}
interface EmbeddingProvider {}
```

Create:

```text
AIProviderRegistry
AIRequestRouter
AIUsageTracker
AIModelRegistry
```

Provider configuration must not leak into Domain.

---

# 16. PHASE 10 — STRUCTURED AI EXTRACTION

AI must return structured output.

Example:

```json
{
  "profession": {
    "value": "beauty",
    "confidence": 0.94
  },
  "specialties": [
    {
      "value": "hair_coloring",
      "confidence": 0.91
    }
  ],
  "city": {
    "value": "Shiraz",
    "confidence": 0.88
  }
}
```

Validate all outputs against a schema.

Reject malformed output.

Use retry/repair only within controlled limits.

---

# 17. PHASE 11 — EVIDENCE

Every significant AI result must produce Evidence.

Evidence should reference:

```text
source
content
location
timestamp
model
confidence
```

Do not fabricate evidence.

If no evidence exists:

```text
evidence = []
confidence must reflect uncertainty
```

---

# 18. PHASE 12 — VISION

Create Vision Provider abstraction.

The system should support sample-based analysis.

Do not analyze all content by default.

Strategy:

```text
Profile
↓
Metadata
↓
Representative Content
↓
Vision if necessary
```

If confidence is already high, avoid unnecessary Vision calls.

---

# 19. PHASE 13 — JE V / DECISION PROVIDER

Implement:

```typescript
interface DecisionProvider {
  decide(
    input: DecisionInput
  ): Promise<DecisionResult>;
}
```

Decision result:

```text
options
probabilities
selectedOption
provider
modelVersion
```

Application code controls:

```text
threshold
fallback
retry
review
```

Do not allow Decision Provider to own business workflow.

---

# 20. PHASE 14 — SCORING

Implement separate scoring engines:

```text
LeadRelevanceScorer
AudienceQualityScorer
BusinessActivityScorer
ConfidenceCalculator
PriorityScorer
```

Scores must remain independently queryable.

Make weighting configurable.

---

# 21. PHASE 15 — AUDIENCE QUALITY

Use risk-oriented language.

Allowed:

```text
Audience Quality
Audience Risk
Suspicious Signals
Confidence
```

Avoid presenting inferred values as factual fake-follower percentages.

Store supporting signals.

---

# 22. PHASE 16 — HUMAN REVIEW

Implement:

```text
Review Queue
Review Detail
Accept
Reject
Correct
```

Store:

```text
original prediction
human correction
reason
reviewer
timestamp
model version
```

---

# 23. PHASE 17 — FEEDBACK DATASET

Every correction becomes structured evaluation data.

Example:

```text
input
prediction
human_label
model_version
taxonomy_version
timestamp
```

Create APIs for retrieving evaluation samples.

---

# 24. PHASE 18 — CAMPAIGNS

Implement:

```text
Create Campaign
Add Leads
Remove Leads
Bulk Add
Bulk Remove
Filter-based Campaign
Export Campaign
```

Campaign is an organizational object.

It does not send messages.

---

# 25. PHASE 19 — SEARCH

Support:

```text
source
profession
specialty
city
activity
relevance
audience quality
confidence
status
```

Use PostgreSQL first.

Do not introduce Elasticsearch/OpenSearch unless justified by actual scale.

---

# 26. PHASE 20 — NATURAL LANGUAGE SEARCH

Create a parser layer:

```text
Natural Language
↓
Structured Search Query
↓
Validation
↓
Search Engine
```

Never directly execute LLM-generated database queries.

LLM may produce a typed query object.

Application validates it.

---

# 27. PHASE 21 — EXPORT

Implement:

```text
CSV
JSON
Excel
```

Export asynchronously through Queue.

Never generate huge exports synchronously in HTTP request.

---

# 28. PHASE 22 — OBSERVABILITY

Instrument:

```text
HTTP
Database
Queue
Connector
AI
Vision
Jev
Export
```

Every operation should have trace/correlation information.

---

# 29. PHASE 23 — TESTING

Minimum tests:

## Unit

- Normalization
- Taxonomy
- Scoring
- Threshold
- Deduplication
- Query parsing

## Integration

- Database
- Connector
- AI Gateway
- Queue
- Campaign

## E2E

```text
Discovery
→ Lead
→ Analysis
→ Score
→ Review
→ Campaign
→ Export
```

---

# 30. PHASE 24 — SECURITY REVIEW

Verify:

```text
Authentication
Authorization
Tenant Isolation
Input Validation
Secret Handling
API Security
Audit Logs
File Upload Security
Webhook Security
```

Do not store secrets in source code.

---

# 31. PHASE 25 — PERFORMANCE

Measure:

```text
Discovery throughput
AI processing latency
Database query latency
Queue latency
Export performance
```

Optimize only after measurement.

---

# 32. PHASE 26 — DOCUMENTATION

Maintain:

```text
README
ARCHITECTURE.md
PRD.md
ADR/
DATABASE.md
API.md
AI.md
CONNECTORS.md
TAXONOMY.md
SCORING.md
SECURITY.md
```

Documentation must remain synchronized with code.

---

# 33. DEFINITION OF DONE

A phase is not complete merely because code compiles.

A phase is complete when:

```text
Implementation
+
Tests
+
Validation
+
Documentation
+
Architecture Review
```

are complete.

---

# 34. CODING RULES

Prefer:

```text
Clean Architecture principles
SOLID
Explicit interfaces
Dependency inversion
Typed DTOs
Typed domain objects
Small modules
Small functions
Clear naming
```

Avoid:

```text
God classes
God services
Any types
Hidden global state
Hardcoded providers
Hardcoded taxonomy
Hardcoded scoring
Direct external API calls from domain
```

---

# 35. DATABASE RULES

Use migrations.

Never modify production schema manually.

Every schema change must have:

```text
migration
test
documentation
```

Use transactions for multi-entity domain operations.

---

# 36. API RULES

All APIs must:

```text
validate input
authenticate
authorize
return typed responses
return structured errors
include request ID
```

Use OpenAPI.

---

# 37. AI RULES

Never trust raw AI output.

Pipeline:

```text
AI
↓
Schema Validation
↓
Grounding/Evidence Validation
↓
Business Rules
↓
Decision
```

---

# 38. AI COST RULE

Do not call expensive models unnecessarily.

Prefer:

```text
Rules
↓
Cheap Model
↓
Jev
↓
Vision
↓
Strong Model
↓
Human
```

according to confidence and task requirements.

---

# 39. MODEL VERSIONING

Every AI result must record:

```text
provider
model
version
prompt version
schema version
taxonomy version
```

---

# 40. NO BLIND REFACTORING

Before changing existing code:

1. Understand it.
2. Determine dependencies.
3. Run tests.
4. Make minimal change.
5. Re-run tests.

Do not rewrite functioning modules merely for stylistic reasons.

---

# 41. NO PREMATURE MICROSERVICES

Keep the application modular.

Extract a service only when there is a measurable reason:

```text
scale
deployment independence
resource isolation
team boundary
failure isolation
```

---

# 42. FUTURE EXTENSION POINTS

Architecture must allow:

```text
Google Maps Connector
LinkedIn Connector
YouTube Connector
Website Connector
CSV Connector
CRM Connector
```

and:

```text
Anthropic
OpenAI
Gemini
GLM
Local LLM
Future LLM
```

without rewriting Domain.

---

# 43. FUTURE GNN BOUNDARY

Create no GNN implementation now.

But leave:

```text
GraphProvider
GraphFeatureProvider
GraphAnalysisProvider
```

as future architectural concepts only if they do not add unnecessary complexity.

---

# 44. FUTURE PARSE-STYLE OPTIMIZATION

Do not implement a full PARSE framework in MVP.

Keep:

```text
SchemaRegistry
PromptVersion
ExtractionValidator
RetryPolicy
```

clean enough that schema optimization can be added later.

---

# 45. FINAL IMPLEMENTATION ORDER

Execute in this order:

```text
0. Repository Audit

1. Foundation
2. Database
3. Domain
4. Taxonomy
5. Source Architecture
6. First Connector
7. Raw Data
8. Normalization
9. Deduplication
10. AI Gateway
11. Structured Extraction
12. Evidence
13. Vision
14. Decision Provider
15. Scoring
16. Audience Quality
17. Human Review
18. Feedback
19. Search
20. Campaign
21. Export
22. Observability
23. Testing
24. Security
25. Performance
26. Documentation
```

---

# 46. IMPORTANT EXECUTION BEHAVIOR

Do not ask for permission after every tiny implementation step.

Instead:

1. Analyze the current phase.
2. Implement it.
3. Test it.
4. Report the result.
5. Stop at the defined phase boundary.

Do not silently move to unrelated future phases.

---

# 47. REPORT FORMAT

After every phase report:

```text
PHASE:
STATUS:

Implemented:
- ...

Files Changed:
- ...

Database Changes:
- ...

Tests:
- ...

Architecture Decisions:
- ...

Known Issues:
- ...

Next Phase:
- ...
```

---

# 48. FIRST COMMAND

Your first task is NOT implementation.

Your first task is:

```text
AUDIT THE REPOSITORY
```

Then produce:

```text
1. Current Architecture
2. Existing Modules
3. Existing Dependencies
4. Existing Database
5. Existing Tests
6. Existing Problems
7. Compatibility Risks
8. Recommended Implementation Plan
9. Files that should NOT be modified
10. Phase 0 completion report
```

Do not start major implementation until the repository audit is complete.

---

# 49. FINAL PRODUCT PRINCIPLE

The final product must behave as:

```text
                    Universal Lead Intelligence
                              │
             ┌────────────────┼─────────────────┐
             ↓                ↓                 ↓
          Sources            AI              Humans
             │                │                 │
       ┌─────┼─────┐      ┌───┼────┐            │
       ↓     ↓     ↓      ↓   ↓    ↓            │
   Instagram Maps Website LLM Vision Jev        Review
       │     │     │       │   │    │            │
       └─────┼─────┘       └───┼────┘            │
             ↓                 ↓                 │
             └───────── Lead Intelligence ──────┘
                              │
                              ↓
                     Evidence + Scores
                              │
                              ↓
                    Campaign / Export / CRM
```

The architecture must remain extensible enough that adding a new data source or AI provider does not require rewriting the Core Domain.

END OF MASTER PROMPT.
