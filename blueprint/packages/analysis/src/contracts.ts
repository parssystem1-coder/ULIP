/**
 * Analysis runtime contracts (Phase 16).
 *
 * This package CONNECTS the existing typed AI contracts (@ulip/ai) to the
 * existing orchestration/scoring/database model — it does not introduce a
 * competing contract. Anything persisted maps onto lead_analyses / evidence /
 * lead_classifications / lead_scores / audience_quality / ai_runs as defined
 * in database/schema/schema.sql.
 *
 * Design rules:
 *  - No `unknown` in public contracts (ADR-023).
 *  - Evidence-first: every classification carries evidence ids, confidence,
 *    provenance and versions (ADR-008).
 *  - The store is an interface so the flow is unit-testable without
 *    PostgreSQL; DbAnalysisStore is the real implementation (ADR-025).
 */

import type {
  AnalysisMode,
  Availability,
  ClassificationType,
  EvidenceType,
} from '@ulip/domain/contracts';
import type {
  ErrorCode,
  FailureAction,
  PipelineStep,
  ProcessingEvent,
  ProcessingStage,
} from '@ulip/orchestration';
import type { AiRuntime } from '@ulip/ai';
import type {
  ResolvedScoringPolicy,
  ScoreDimensionInput,
  ScoreReviewOutcome,
} from '@ulip/scoring';
import type { StructuredProfile, TaxonomyOption } from '@ulip/ai';

// ---------------------------------------------------------------------------
// Job payload + errors
// ---------------------------------------------------------------------------

export interface AnalysisJobPayload {
  leadId: string;
  analysisMode: AnalysisMode;
  /** Why this run was queued (discovery | reprocess | manual | resume). */
  reason: string;
  /** Requested search criteria for per-content relevance scoring (§11). */
  relevanceCriteria?: string | undefined;
}

export class AnalysisInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisInputError';
  }
}

/** Lead is not in a processable state (idempotent no-op, job → SKIPPED). */
export class AnalysisSkipError extends Error {
  readonly currentStatus: string;
  constructor(currentStatus: string, message: string) {
    super(message);
    this.name = 'AnalysisSkipError';
    this.currentStatus = currentStatus;
  }
}

/**
 * A run failed after the ANALYZING transition. Carries the orchestration
 * failure code + policy action so the worker can apply the existing
 * failure/retry lifecycle without guessing.
 */
export class AnalysisRunError extends Error {
  readonly code: ErrorCode;
  readonly action: FailureAction;
  /** True when the lead was already moved into ANALYZING. */
  readonly leadTransitioned: boolean;
  readonly cause?: unknown;

  constructor(input: {
    code: ErrorCode;
    action: FailureAction;
    message: string;
    leadTransitioned: boolean;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'AnalysisRunError';
    this.code = input.code;
    this.action = input.action;
    this.leadTransitioned = input.leadTransitioned;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvidenceDraft {
  /** Deterministic UUID (analysis-scoped) → duplicate runs insert nothing new. */
  id: string;
  leadId: string;
  evidenceType: EvidenceType;
  /** Source system type (e.g. INSTAGRAM, FAKE, PLATFORM). */
  sourceType: string;
  /** Traceable origin locator — no synthetic provenance (schema CHECK). */
  sourceReference: string;
  content: string | null;
  contentHash: string;
  retrievedAt: string;
  confidence: number;
  metadata: Record<string, string | number | boolean | null>;
}

/** An evidence sample as handed to the LLM (contentId === evidence id). */
export interface EvidenceSample {
  contentId: string;
  text?: string;
  publishedAt?: string;
}

// ---------------------------------------------------------------------------
// Lead context (everything analysis may read)
// ---------------------------------------------------------------------------

export interface LeadIdentityContext {
  sourceId: string;
  sourceType: string;
  externalId: string;
  username: string | null;
  profileUrl: string | null;
  displayName: string | null;
}

export interface LeadContentContext {
  id: string;
  contentType: string;
  text: string | null;
  mediaUrl: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  metadata: Record<string, unknown>;
}

export interface RawPayloadContext {
  rawId: string;
  sourceType: string;
  externalId: string;
  entityType: string;
  collectedAt: string;
  payload: Record<string, unknown>;
}

export interface RuleClassificationContext {
  classificationType: ClassificationType;
  taxonomyNodeId: string | null;
  valueText: string | null;
  valueNormalized: string | null;
  source: 'AI' | 'RULE' | 'HUMAN';
  confidence: number | null;
}

export interface LocationContext {
  country: string;
  province: string | null;
  city: string | null;
  district: string | null;
  rawValue: string;
  availability: Availability;
  confidence: number | null;
}

export interface ContactContext {
  kind: string;
  availability: Availability;
  /** Values are NEVER copied into evidence (PII minimization). */
  isSensitive: boolean;
}

export interface TaxonomyCatalog {
  nodes: TaxonomyOption[];
  /** alias_norm → node id (already normalized by the database). */
  aliases: { nodeId: string; aliasNorm: string }[];
  /** Max taxonomy_nodes.version for the tenant (recorded on the analysis). */
  version: number;
}

export interface LeadContext {
  leadId: string;
  tenantId: string;
  businessId: string;
  status: ProcessingStage;
  analysisMode: AnalysisMode;
  business: {
    canonicalName: string;
    description: string | null;
    website: string | null;
    businessTypeNodeId: string | null;
    industryNodeId: string | null;
  };
  identities: LeadIdentityContext[];
  contents: LeadContentContext[];
  rawPayloads: RawPayloadContext[];
  locations: LocationContext[];
  contacts: ContactContext[];
  /** Pre-existing classifications (RULE hints from discovery, HUMAN corrections). */
  existingClassifications: RuleClassificationContext[];
  taxonomy: TaxonomyCatalog;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ClassificationDraft {
  classificationType: ClassificationType;
  taxonomyNodeId: string | null;
  valueText: string | null;
  valueNormalized: string | null;
  confidence: number;
  source: 'AI' | 'RULE' | 'HUMAN';
  modelVersion: string | null;
}

export interface AnalysisRecordDraft {
  id: string;
  analysisVersion: string;
  modelVersion: string | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  taxonomyVersion: number;
  analysisMode: AnalysisMode;
  summary: string;
  structuredOutput: Record<string, unknown>;
  confidence: number | null;
}

export interface ScoreRecordDraft {
  id: string;
  scoringPolicyVersionId: string;
  relevance: number;
  audienceQuality: number;
  activity: number;
  confidence: number;
  priority: number;
}

export interface AudienceQualityDraft {
  id: string;
  qualityScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  signals: Record<string, unknown>[];
  confidence: number;
  modelVersion: string;
}

export interface AiRunDraft {
  /** Deterministic UUID → duplicate runs insert nothing new. */
  id: string;
  provider: string;
  providerType: 'LLM' | 'VISION' | 'DECISION' | 'EMBEDDING' | 'OTHER';
  model: string;
  status: 'SUCCESS' | 'FAILED' | 'RETRY' | 'TIMEOUT';
  latencyMs: number;
  inputHash: string;
  outputHash: string;
  promptVersion: string;
  schemaVersion: string;
  error?: string | undefined;
}

export interface PersistRunInput {
  tenantId: string;
  leadId: string;
  jobId: string;
  analysis: AnalysisRecordDraft;
  evidenceIds: string[];
  classifications: ClassificationDraft[];
  score: ScoreRecordDraft;
  audienceQuality: AudienceQualityDraft;
  aiRun: AiRunDraft;
  /** Phase 18: versioned content-intelligence result (absent on legacy paths). */
  contentAnalysis?: ContentAnalysisPersist | undefined;
}

// ---------------------------------------------------------------------------
// Content intelligence persistence (Phase 18, ADR-030 §13)
// ---------------------------------------------------------------------------

export type ProfileContentConsistency =
  | 'PROFILE_CONTENT_AGREE'
  | 'PROFILE_CONTENT_PARTIAL'
  | 'PROFILE_CONTENT_CONFLICT'
  | 'INSUFFICIENT_CONTENT';

/** One versioned row of content_analyses (deterministic id → idempotent replay). */
export interface ContentAnalysisDraft {
  id: string;
  leadId: string;
  analysisId: string;
  analysisVersion: string;
  analysisMode: AnalysisMode;
  sampling: Record<string, unknown>;
  profileContentConsistency: ProfileContentConsistency;
  consistencyConfidence: number;
  activitySignals: Record<string, unknown>;
  contentRelevance: number | null;
  relevanceCriteria: string | null;
  reviewReasons: string[];
  summary: string;
}

/** One row of content_analysis_items for the content-analysis version above. */
export interface ContentAnalysisItemDraft {
  id: string;
  contentAnalysisId: string;
  leadContentId: string;
  contentType: string;
  selectedReasons: string[];
  textAnalyzed: boolean;
  imageAnalyzed: boolean;
  mediaAnalyzed: boolean;
  modalityNotes: Record<string, string>;
  relevance: number | null;
  relevanceSignals: string[];
  topics: string[];
}

/** Content-intelligence payload carried through persistRun in one transaction. */
export interface ContentAnalysisPersist {
  analysis: ContentAnalysisDraft;
  items: ContentAnalysisItemDraft[];
  /** Separate VISUAL_ANALYSIS ai_run when a vision step actually ran. */
  visionRun?: AiRunDraft | undefined;
}

/** Read-side summary of the content-intelligence result (outcome + API). */
export interface ContentAnalysisSummary {
  contentAnalysisId: string;
  consistency: ProfileContentConsistency;
  consistencyConfidence: number;
  activityScore: number | null;
  contentRelevance: number | null;
  sampledCount: number;
  consideredCount: number;
  modalityNotes: Record<string, string>;
  visionReason: string;
  reviewReasons: string[];
}

export interface PersistRunResult {
  analysisId: string;
  scoreId: string;
  evidenceLinked: number;
  classificationsInserted: number;
  supersededAnalysisId: string | null;
  supersededScoreId: string | null;
}

export interface AnalysisStore {
  /** Loads everything analysis may read, tenant-scoped. null ⇒ 404. */
  loadContext(tenantId: string, leadId: string, analysisMode: AnalysisMode): Promise<LeadContext | null>;
  /** True when THIS job already persisted a successful run (idempotent replay). */
  hasSuccessfulRun(jobId: string, leadId: string): Promise<boolean>;
  /** Evidence-first: persists drafts before the model is called (idempotent). */
  persistEvidence(drafts: EvidenceDraft[]): Promise<number>;
  /** One transaction: analysis + evidence link + classifications + scores. */
  persistRun(run: PersistRunInput): Promise<PersistRunResult>;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface AnalysisPolicyService {
  /** Resolves the ACTIVE scoring policy version for the tenant. */
  resolve(tenantId: string): Promise<ResolvedScoringPolicy>;
  /** Resolves, bootstrapping the documented default policy when absent. */
  resolveOrBootstrap(tenantId: string): Promise<ResolvedScoringPolicy>;
}

// ---------------------------------------------------------------------------
// Lifecycle (the ONLY writer of leads.status)
// ---------------------------------------------------------------------------

export interface LeadLifecycle {
  applyLeadEvent(input: {
    leadId: string;
    tenantId?: string | undefined;
    event: ProcessingEvent;
    expectedFrom: ProcessingStage;
    to?: ProcessingStage | undefined;
  }): Promise<ProcessingStage>;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface AnalysisLogSink {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AnalysisFlowDeps {
  log: AnalysisLogSink;
  store: AnalysisStore;
  ai: AiRuntime;
  policy: AnalysisPolicyService;
  lifecycle: LeadLifecycle;
  /** Optional step progress for the persistent job row. */
  progress?: ((step: PipelineStep, percent: number) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface AnalysisRunContext {
  tenantId: string;
  jobId: string;
  correlationId?: string | null | undefined;
  jobType?: string | undefined;
}

export interface ClassificationSummary {
  classificationType: ClassificationType;
  value: string;
  taxonomyNodeId: string | null;
  confidence: number;
  availability: Availability;
  evidenceIds: string[];
}

export interface ScoreReason {
  dimension: 'relevance' | 'audienceQuality' | 'activity' | 'confidence';
  code: string;
  message: string;
  delta: number;
  evidenceIds: string[];
}

export interface UncertainField {
  field: string;
  value: string;
  reason: string;
}

export interface AnalysisOutcome {
  leadId: string;
  tenantId: string;
  analysisId: string;
  scoreId: string;
  analysisVersion: string;
  provider: string;
  providerKind: 'HTTP' | 'FAKE' | 'NONE' | 'RULES_FALLBACK';
  evidenceCount: number;
  classifications: ClassificationSummary[];
  dimensions: ScoreDimensionInput;
  priority: number;
  reviewOutcome: ScoreReviewOutcome;
  finalStatus: ProcessingStage;
  uncertainFields: UncertainField[];
  reasons: ScoreReason[];
  /** Phase 18: present when the lead had content to analyze. */
  contentAnalysis?: ContentAnalysisSummary | undefined;
}
