# Data Dictionary

Statuses are Postgres enums (schema.sql ENUMS section). Availability values:
`AVAILABLE | PARTIAL | INFERRED | UNAVAILABLE`.

| Entity | Field | Type | Meaning |
|---|---|---|---|
| Tenant | id | UUID | Internal tenant identity |
| User | role | roles FK | OWNER / ADMIN / ANALYST / REVIEWER / VIEWER |
| Source | type | text | Source category (e.g. INSTAGRAM) |
| RawEntity | content_hash | text | Payload fingerprint; snapshot identity (source, external_id, hash) |
| RawEntity | ingest_status | ingest_status | PENDING / PROCESSED / DISCARDED |
| RawEntityCurrent | raw_entity_id | UUID | Latest snapshot pointer per entity identity |
| Business | business_type_node_id | UUID FK | FIRST-CLASS Business Type (ADR-018) |
| Business | industry_node_id | UUID FK | Industry taxonomy node |
| BusinessLocation | availability | availability | Honest location availability; INFERRED ≠ fact |
| BusinessLocation | confidence | numeric(5,4) | 0..1 when PARTIAL/INFERRED |
| BusinessContact | kind | contact_kind | PHONE / MOBILE / WHATSAPP / EMAIL / WEBSITE / SOCIAL |
| BusinessContact | value_normalized | text | E.164 phones, lowercased hosts, etc. |
| BusinessContact | is_sensitive | boolean | Personal channel → restricted exposure (PII-DATA-MODEL) |
| Lead | status | lead_status | DB-enforced lifecycle (ORCHESTRATION.md) |
| LeadIdentity | external_id | text | Source identity |
| LeadContent | content_hash | text | Provenance fingerprint |
| LeadContent | retrieved_at | timestamptz | Collection time (no synthetic provenance) |
| TaxonomyNode | node_kind | node_kind | BUSINESS_TYPE / INDUSTRY / SPECIALTY / SUB_SPECIALTY |
| TaxonomyNodeTranslation | locale | text | e.g. fa / en |
| TaxonomyNodeAlias | alias_norm | text | Normalized lookup key (persian-normalize output) |
| LeadClassification | classification_type | classification_type | BUSINESS_TYPE / INDUSTRY / SPECIALTY / SUB_SPECIALTY / BRAND / OTHER |
| LeadClassification | value_text | text | Free value when no canonical node (e.g. Brand "HP") |
| LeadAnalysis | analysis_mode | analysis_mode | BASIC / STANDARD / DEEP / BE_REUSE |
| LeadAnalysis | is_current | boolean | Exactly one per lead (partial unique index) |
| LeadAnalysis | superseded_at | timestamptz | Set when retired; NULL while current |
| Evidence | analysis_id | UUID FK | Analysis provenance — no post-hoc orphan evidence |
| Evidence | source_reference | text | Traceable origin locator (mandatory) |
| Evidence | content_hash | text | Provenance fingerprint |
| LeadScore | scoring_policy_version_id | UUID FK | Policy version stamped on every score |
| LeadScore | is_current / superseded_at | bool/ts | Current-version semantics (ADR-024) |
| AudienceQuality | risk_level | text CHECK | LOW / MEDIUM / HIGH / UNKNOWN (never fake-%) |
| Decision | decision_options | jsonb | Typed DecisionOption[] (ids, not A/B/C) |
| Decision | probabilities | jsonb | { optionId, probability }[] — gateway-validated |
| Decision | status | decision_status | ACCEPTED / REVIEW_REQUIRED / REJECTED / ABSTAINED |
| EntityResolutionCandidate | verdict | match_verdict | SAME_ENTITY / DIFFERENT_ENTITIES / UNCERTAIN |
| EntityResolutionCandidate | decided_by | text CHECK | AI / RULES / HUMAN / PENDING |
| Job | status | job_status | PENDING / RUNNING / SUCCEEDED / FAILED / CANCELLED / SKIPPED |
| Job | current_step | job_step | DISCOVERY..SCORING (VISION/DECISION inside ANALYZING) |
| Job | progress | smallint | 0..100, step-weighted |
| JobAttempt | outcome | text CHECK | SUCCESS / RETRYABLE_FAILURE / FATAL_FAILURE |
| IdempotencyKey | scope | text | Endpoint scope, e.g. `POST /discovery/search` |
| IdempotencyKey | request_hash | text | Replay-conflict detection (same key + different body → 409) |
| ScoringPolicyVersion | weights | jsonb | { relevance, audienceQuality, activity, confidence } sum 1 |
| ScoringPolicyVersion | thresholds | jsonb | { qualifiedMin, reviewMin, rejectMax } 0..100 |
| DecisionPolicyVersion | decision_strategy | text CHECK | RULES_ONLY … RULES_LLM_DECISION_PROVIDER (ADR-017) |
| DecisionPolicyVersion | accept/review/reject/fallback_threshold | numeric(5,4) | Persisted, ordered thresholds |
| HumanReview | corrected_value | jsonb | User's correction; history never overwritten |
| AIRun | estimated_cost | numeric(14,6) | Provider/accounting estimate when available |
| AuditLog | before_json / after_json | jsonb | Previous/next state for auditable edits |
