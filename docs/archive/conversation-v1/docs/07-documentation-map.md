# Documentation Map & Implementation Order

## Purpose

این فایل نقشه استفاده از کل مستندات این بسته است و مشخص می‌کند هر سند در چه مرحله‌ای از توسعه استفاده شود.

## 1. Product Definition

Read first:

- `docs/01-prd.md`

Purpose:

- What the product is
- Who it serves
- MVP scope
- Out of scope
- Success criteria

## 2. Architecture

Then read:

- `docs/00-master-architecture-spec.md`
- `docs/architecture/02-technical-architecture-and-adr.md`

Purpose:

- System boundaries
- Modules
- Provider abstraction
- Connector architecture
- AI/LLM/Vision/Jev separation
- Evidence
- Human review
- Queue and observability
- Architecture decisions

## 3. Data Model

Then read:

- `docs/database/03-database-erd.md`

Purpose:

- Core entities
- Relationships
- Indexing
- JSONB boundaries
- Versioning

## 4. API

Then read:

- `docs/api/04-api-contract.md`

Purpose:

- REST resources
- Request/response contracts
- Error format
- Pagination
- Versioning
- OpenAPI requirements

## 5. Implementation Prompt

Finally use:

- `prompts/05-master-prompt-claude-code.md`

Purpose:

- Repository audit
- Phase-by-phase implementation
- Testing
- Documentation
- Security
- Completion reporting

## 6. File Blueprint

Reference:

- `docs/implementation/06-repository-file-tree.md`

Purpose:

- Target repository structure
- Module boundaries
- Future extension points

## 7. Execution Order

```text
PRD
 ↓
Master Architecture
 ↓
Technical Architecture / ADR
 ↓
Database / ERD
 ↓
API Contract
 ↓
Repository Audit
 ↓
Foundation
 ↓
Database + Domain
 ↓
Taxonomy
 ↓
Source / Connector Layer
 ↓
Raw Data + Normalization + Dedup
 ↓
AI Gateway
 ↓
Extraction + Evidence + Vision + Jev
 ↓
Scoring + Audience Quality
 ↓
Human Review + Feedback
 ↓
Search + Campaign
 ↓
Export
 ↓
Observability
 ↓
Testing
 ↓
Security
 ↓
Performance
 ↓
Documentation
```

## 8. MVP Boundary

Included:

```text
One permitted/authorized source connector
Lead data model
Taxonomy
Normalization
Deduplication
LLM
Vision abstraction
Decision/Jev abstraction
Evidence
Scoring
Audience Quality
Human Review
Campaign
Export
Usage tracking
Audit
```

Deferred:

```text
GNN
Full PARSE implementation
Microservices
Advanced knowledge graph
Autonomous outreach
Plugin marketplace
Large CRM module
```

## 9. Final Architectural Principle

```text
Data Source ≠ Intelligence Engine
LLM ≠ Decision System
AI ≠ Business Rules
Evidence ≠ Prediction
Campaign ≠ Outreach
```

The architecture should remain capable of accepting additional data sources and AI providers without rewriting the core domain.
