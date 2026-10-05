/**
 * ULIP domain contracts — single source of truth for shared domain types.
 *
 * These types are mirrored by:
 *  - docs/ai/TASK-CONTRACTS.md
 *  - database/schema/schema.sql (enums)
 *  - docs/api/OPENAPI.yaml (component schemas)
 * Any change here must propagate to all three (see ADR-024).
 *
 * No `unknown` in public contracts (ADR-023). External payloads are
 * `Record<string, unknown>` deliberately: they represent untrusted,
 * schema-less source data until normalization types them.
 */

// ---------------------------------------------------------------------------
// Data availability
// ---------------------------------------------------------------------------

export type Availability = 'AVAILABLE' | 'PARTIAL' | 'INFERRED' | 'UNAVAILABLE';

/** A field with honest availability semantics. Never present INFERRED as fact. */
export interface TypedField<T> {
  value: T;
  availability: Availability;
  confidence?: number; // 0..1 when PARTIAL/INFERRED
  evidenceIds?: string[];
}

// ---------------------------------------------------------------------------
// Lifecycle (mirrors lead_status enum in schema.sql)
// ---------------------------------------------------------------------------

export type LeadStatus =
  | 'DISCOVERED'
  | 'RAW_STORED'
  | 'NORMALIZED'
  | 'DEDUP_CHECKED'
  | 'ANALYSIS_PENDING'
  | 'ANALYZING'
  | 'SCORED'
  | 'REVIEW_REQUIRED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'FAILED'
  | 'ARCHIVED';

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export type TaxonomyNodeKind = 'BUSINESS_TYPE' | 'INDUSTRY' | 'SPECIALTY' | 'SUB_SPECIALTY';

export interface TaxonomyNodeRef {
  id: string;
  tenantId: string;
  parentId: string | null;
  nodeKind: TaxonomyNodeKind;
  slug: string;
  name: string;
}

export type ClassificationSource = 'AI' | 'RULE' | 'HUMAN';

export type ClassificationType =
  | 'BUSINESS_TYPE'
  | 'INDUSTRY'
  | 'SPECIALTY'
  | 'SUB_SPECIALTY'
  | 'BRAND'
  | 'OTHER';

export interface ClassificationRef {
  classificationType: ClassificationType;
  /** Canonical taxonomy node when one exists; null for free values (e.g. Brand "HP"). */
  taxonomyNodeId: string | null;
  valueText: string | null;
  confidence?: number;
  source: ClassificationSource;
  modelVersion?: string;
}

// ---------------------------------------------------------------------------
// Location / contacts
// ---------------------------------------------------------------------------

export type ContactKind = 'PHONE' | 'MOBILE' | 'WHATSAPP' | 'EMAIL' | 'WEBSITE' | 'SOCIAL';

export interface ContactValue {
  kind: ContactKind;
  value: string;
  valueNormalized: string;
  availability: Availability;
  confidence?: number;
  /** Private/sensitive channel; restricted exposure, never exported by default. */
  isSensitive: boolean;
}

export interface LocationValue {
  country?: string;
  province?: string;
  city?: string;
  district?: string;
  rawValue: string;
  availability: Availability;
  confidence?: number;
  evidenceIds?: string[];
}

// ---------------------------------------------------------------------------
// Identity / lead / business
// ---------------------------------------------------------------------------

export interface LeadIdentityRef {
  sourceType: string;
  externalId: string;
  username?: string;
  profileUrl?: string;
  displayName?: string;
}

/** The tenant/workflow-facing prospect record. */
export interface UniversalLeadContract {
  id: string;
  tenantId: string;
  businessId: string;
  status: LeadStatus;
  identities: LeadIdentityRef[];
}

/** Canonical real-world entity; carries first-class business type. */
export interface BusinessContract {
  id: string;
  tenantId: string;
  canonicalName: string;
  /** First-class Business Type (Wholesaler, Manufacturer, Service Provider, ...). */
  businessTypeNodeIds: string[];
  industryNodeIds: string[];
  website?: string;
  locations: LocationValue[];
  contacts: ContactValue[];
}

// ---------------------------------------------------------------------------
// Evidence (mirrors evidence_type CHECK in schema.sql)
// ---------------------------------------------------------------------------

export type EvidenceType =
  | 'BIO_TEXT'
  | 'CAPTION_TEXT'
  | 'IMAGE_OBSERVATION'
  | 'CONTENT_METADATA'
  | 'LOCATION_SIGNAL'
  | 'PROFILE_METADATA'
  | 'ENGAGEMENT_SIGNAL'
  | 'MODEL_INFERENCE'
  | 'HUMAN_CORRECTION';

export interface EvidenceRef {
  id: string;
  type: EvidenceType;
  sourceType: string;
  sourceReference: string;
  contentHash: string;
  retrievedAt: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type AnalysisMode = 'BASIC' | 'STANDARD' | 'DEEP' | 'BE_REUSE';

export interface LeadAnalysisRef {
  id: string;
  leadId: string;
  analysisVersion: string;
  modelVersion?: string;
  promptVersion?: string;
  schemaVersion?: string;
  taxonomyVersion: number;
  analysisMode: AnalysisMode;
  confidence?: number;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// Scores (relevance ≠ audience quality, always)
// ---------------------------------------------------------------------------

export interface LeadScoresContract {
  relevance: number; // 0..100
  audienceQuality: number; // 0..100, independent of relevance
  activity: number; // 0..100
  confidence: number; // 0..100
  priority: number; // 0..100
  scoringPolicyVersion: string;
}

// ---------------------------------------------------------------------------
// Search — structured filters are authoritative; NL search yields this type.
// ---------------------------------------------------------------------------

export interface LeadSearchFilters {
  businessTypes?: string[]; // taxonomy node ids or slugs
  industries?: string[];
  specialties?: string[];
  subSpecialties?: string[];
  brands?: string[];
  city?: string;
  country?: string;
  sourceType?: string;
  status?: LeadStatus;
  minRelevance?: number;
  minAudienceQuality?: number;
  minActivity?: number;
  minConfidence?: number;
}

export interface SearchPagination {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface SortSpec {
  field: 'relevance' | 'priority' | 'activity' | 'audienceQuality' | 'createdAt';
  direction: 'ASC' | 'DESC';
}

/** The only shape a search may execute. An LLM must never emit SQL. */
export interface StructuredSearchQuery {
  filters: LeadSearchFilters;
  pagination: SearchPagination;
  sort?: SortSpec[];
}
