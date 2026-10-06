import type { AiMetadata, StructuredProfile } from '@ulip/ai';
import {
  AiSchemaValidationError,
  enforceEvidenceFirst,
  validateExtractionOutput,
  type ExtractionResult,
  type ProfileExtractionInput,
} from '@ulip/ai';
import { score } from '@ulip/scoring';
import type {
  AiRunDraft,
  AnalysisOutcome,
  AnalysisFlowDeps,
  AnalysisRunContext,
  ContentAnalysisDraft,
  ContentAnalysisItemDraft,
  ContentAnalysisPersist,
  ContentAnalysisSummary,
  EvidenceDraft,
  LeadContext,
} from './contracts.ts';
import { computeDimensions } from './dimensions.ts';
import { deterministicUuid, sha256Hex } from './ids.ts';
import { analysisMeta, buildUniversalModel, composeSummary, mapClassifications } from './profile.ts';
import type { ActivitySignals, AggregatedSignal, ConsistencyResult, ContentRelevance } from './intel.ts';
import type { MultimodalRunResult } from './multimodal.ts';
import type { SamplingResult } from './sampling.ts';

/** Everything the Phase 18 content pipeline produced for one run. */
export interface ContentIntelBundle {
  sampling: SamplingResult;
  aggregated: AggregatedSignal[];
  consistency: ConsistencyResult;
  relevance: ContentRelevance;
  activity: ActivitySignals;
  multimodal: MultimodalRunResult;
  /** Requested search criteria when the job carried them (§11). */
  criteria: string | null;
}

export interface CompleteRunInput {
  deps: AnalysisFlowDeps;
  ctx: AnalysisRunContext;
  context: LeadContext;
  analysisId: string;
  profile: StructuredProfile;
  meta: AiMetadata;
  providerKind: 'HTTP' | 'FAKE' | 'RULES_FALLBACK';
  evidenceDrafts: readonly EvidenceDraft[];
  /** IMAGE_OBSERVATION drafts produced by the vision step (may be empty). */
  imageDrafts?: readonly EvidenceDraft[] | undefined;
  demoted: string[];
  startedAt: Date;
  latencyMs: number;
  /** Phase 18 content intelligence (absent on legacy callers). */
  content?: ContentIntelBundle | undefined;
}

/** Evidence-first demotion check helper (mirrors profile.ts `claimed`). */
function isClaimed(p: { availability: string; evidenceIds: string[] } | undefined): boolean {
  return p !== undefined && p.availability !== 'UNAVAILABLE' && p.evidenceIds.length > 0;
}

/**
 * Structured review reasons (§15). Reasons only — no chain-of-thought, no
 * auto-labels: each reason is auditable evidence-first information recorded
 * on the content analysis and surfaced through the API.
 */
export function computeReviewReasons(
  context: LeadContext,
  profile: StructuredProfile,
  evidence: readonly EvidenceDraft[],
  mapped: readonly { draft: { classificationType: string; taxonomyNodeId: string | null } }[],
  bundle: ContentIntelBundle | undefined,
): string[] {
  const reasons: string[] = [];
  if (bundle === undefined) return reasons;

  if (bundle.consistency.signal === 'PROFILE_CONTENT_CONFLICT') {
    reasons.push('PROFILE_CONTENT_CONFLICT');
  }
  if (bundle.consistency.signal === 'INSUFFICIENT_CONTENT' && context.contents.length > 0) {
    reasons.push('INSUFFICIENT_CONTENT');
  }
  const mediaItems = bundle.sampling.selected.filter((s) => s.content.availability.image);
  if (mediaItems.length > 0 && bundle.multimodal.plan.enabled === false) {
    reasons.push('MODALITY_UNAVAILABLE');
  }

  const claimedFields = [profile.businessType, profile.industry, ...profile.specialties].filter(
    (p): p is NonNullable<typeof p> => isClaimed(p),
  );
  if (claimedFields.length > 0) {
    const cited = new Set(claimedFields.flatMap((p) => p.evidenceIds));
    const citedDrafts = evidence.filter((d) => cited.has(d.id));
    const avgConf = citedDrafts.length === 0
      ? 0
      : citedDrafts.reduce((s, d) => s + d.confidence, 0) / citedDrafts.length;
    if (avgConf < 0.7) reasons.push('WEAK_EVIDENCE');
  }
  const claimedBt = isClaimed(profile.businessType);
  const claimedInd = isClaimed(profile.industry);
  const btResolved = mapped.some((m) => m.draft.classificationType === 'BUSINESS_TYPE' && m.draft.taxonomyNodeId !== null);
  const indResolved = mapped.some((m) => m.draft.classificationType === 'INDUSTRY' && m.draft.taxonomyNodeId !== null);
  if ((claimedBt && !btResolved) || (claimedInd && !indResolved)) {
    reasons.push('TAXONOMY_AMBIGUITY');
  }
  return reasons;
}

/** Scoring → one transaction → SCORED → THRESHOLD_MAP (policy-owned). */
export async function completeRun(input: CompleteRunInput): Promise<AnalysisOutcome> {
  const { deps, ctx, context, profile, meta } = input;
  const source = input.providerKind === 'RULES_FALLBACK' ? 'RULE' : 'AI';
  const allEvidence = [...input.evidenceDrafts, ...(input.imageDrafts ?? [])];
  const bundle = input.content;
  const hasContent = context.contents.length > 0;

  const { mapped } = mapClassifications(context.taxonomy, profile, meta.modelVersion, source);
  const policy = await deps.policy.resolveOrBootstrap(context.tenantId);
  const dims = computeDimensions({
    profile,
    evidence: allEvidence,
    context,
    ...(bundle !== undefined && hasContent
      ? {
          content: {
            consistency: bundle.consistency,
            relevance: bundle.relevance,
            activity: bundle.activity,
          },
        }
      : {}),
  });
  const policyLabel = `v${policy.version}/${policy.versionId.slice(0, 8)}`;
  const result = score(dims.dimensions, policy, policyLabel);

  // Phase 18: content contradictions must never silently produce a confident
  // QUALIFIED verdict — conflict demotes QUALIFIED to REVIEW_REQUIRED.
  const reviewReasons = computeReviewReasons(context, profile, allEvidence, mapped, bundle);
  const reviewOutcome: typeof result.reviewOutcome =
    reviewReasons.includes('PROFILE_CONTENT_CONFLICT') && result.reviewOutcome === 'QUALIFIED'
      ? 'REVIEW_REQUIRED'
      : result.reviewOutcome;

  const universal = buildUniversalModel(profile, context.taxonomy, mapped);
  const summary = composeSummary(context, universal, reviewOutcome);

  const claimed = [profile.businessType, profile.industry, ...profile.specialties, profile.city]
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.availability !== 'UNAVAILABLE');
  const confidence = claimed.length > 0
    ? Math.round((claimed.reduce((s, p) => s + p.confidence, 0) / claimed.length) * 10_000) / 10_000
    : null;

  const uncertain = [
    ...dims.uncertain,
    ...input.demoted.map((field) => ({
      field,
      value: String((profile as unknown as Record<string, unknown>)[field] ?? ''),
      reason: 'evidence reference missing or unknown — demoted to UNAVAILABLE',
    })),
  ];
  const structuredOutput: Record<string, unknown> = {
    universal,
    profile,
    reasons: dims.reasons,
    uncertain,
    evidenceRefs: allEvidence.map((d) => d.id),
    ...(hasContent && bundle !== undefined
      ? {
          content: {
            sampling: {
              strategy: bundle.sampling.strategy.strategy,
              depth: bundle.sampling.strategy.depth,
              considered: bundle.sampling.strategy.considered,
              budget: bundle.sampling.strategy.budget,
              selected: bundle.sampling.selected.length,
              skipped: bundle.sampling.skipped.length,
            },
            aggregatedSignals: bundle.aggregated,
            consistency: bundle.consistency,
            relevance: { criteria: bundle.criteria, overall: bundle.relevance.overall, perItem: bundle.relevance.perItem },
            activity: bundle.activity,
            multimodal: {
              visionReason: bundle.multimodal.plan.reason,
              visionSelected: bundle.multimodal.plan.selectedContentIds,
              modalityNotes: bundle.multimodal.modalityNotes,
              observations: bundle.multimodal.observations,
            },
            reviewReasons,
          },
        }
      : {}),
    meta: analysisMeta(meta, input.providerKind, ctx.jobId, context.analysisMode),
  };

  const analysisVersion = `${meta.schemaVersion}.${meta.promptVersion}.${meta.modelVersion}.${ctx.jobId.slice(0, 8)}`;
  const scoreId = deterministicUuid('score', ctx.jobId, context.leadId);
  const quality = dims.dimensions.audienceQuality;
  const aqReasons = dims.reasons.filter((r) => r.dimension === 'audienceQuality');

  const contentAnalysis: ContentAnalysisPersist | undefined =
    hasContent && bundle !== undefined
      ? buildContentAnalysisPersist(ctx, context, input, bundle, analysisVersion, reviewReasons, reviewOutcome)
      : undefined;

  const persisted = await deps.store.persistRun({
    tenantId: context.tenantId,
    leadId: context.leadId,
    jobId: ctx.jobId,
    analysis: {
      id: input.analysisId,
      analysisVersion,
      modelVersion: meta.modelVersion,
      promptVersion: meta.promptVersion,
      schemaVersion: meta.schemaVersion,
      taxonomyVersion: context.taxonomy.version,
      analysisMode: context.analysisMode,
      summary,
      structuredOutput,
      confidence,
    },
    evidenceIds: allEvidence.map((d) => d.id),
    classifications: mapped.map((m) => m.draft),
    score: {
      id: scoreId,
      scoringPolicyVersionId: policy.versionId,
      relevance: result.relevance,
      audienceQuality: result.audienceQuality,
      activity: result.activity,
      confidence: result.confidence,
      priority: result.priority,
    },
    audienceQuality: {
      id: deterministicUuid('audience', ctx.jobId, context.leadId),
      qualityScore: quality,
      riskLevel:
        aqReasons.length === 0 ? 'UNKNOWN' : quality >= 70 ? 'LOW' : quality >= 40 ? 'MEDIUM' : 'HIGH',
      signals: aqReasons.map((r) => ({ code: r.code, message: r.message, delta: r.delta, evidenceIds: r.evidenceIds })),
      confidence: dims.dimensions.confidence / 100,
      modelVersion: meta.modelVersion,
    },
    aiRun: {
      id: deterministicUuid('ai_run', ctx.jobId, context.leadId),
      provider: meta.provider,
      providerType: input.providerKind === 'RULES_FALLBACK' ? 'OTHER' : 'LLM',
      model: meta.modelVersion,
      status: 'SUCCESS',
      latencyMs: input.latencyMs,
      inputHash: sha256Hex(`${context.leadId}|${context.taxonomy.version}|${analysisVersion}`),
      outputHash: sha256Hex(JSON.stringify(profile)),
      promptVersion: meta.promptVersion,
      schemaVersion: meta.schemaVersion,
    },
    ...(contentAnalysis !== undefined ? { contentAnalysis } : {}),
  });

  // State machine: ANALYZING → SCORED → (policy) QUALIFIED/REVIEW/REJECTED.
  await deps.lifecycle.applyLeadEvent({
    leadId: context.leadId,
    tenantId: context.tenantId,
    event: 'ANALYSIS_SUCCEEDED',
    expectedFrom: 'ANALYZING',
    to: 'SCORED',
  });
  const finalStatus = await deps.lifecycle.applyLeadEvent({
    leadId: context.leadId,
    tenantId: context.tenantId,
    event: 'THRESHOLD_MAP',
    expectedFrom: 'SCORED',
    to: reviewOutcome,
  });
  deps.progress?.('SCORING', 100);

  deps.log.info('analysis persisted', {
    jobId: ctx.jobId,
    correlationId: ctx.correlationId ?? null,
    tenantId: context.tenantId,
    leadId: context.leadId,
    analysisId: persisted.analysisId,
    scoreId: persisted.scoreId,
    provider: meta.provider,
    providerKind: input.providerKind,
    priority: result.priority,
    reviewOutcome,
    supersededAnalysisId: persisted.supersededAnalysisId,
  });

  const contentSummary: ContentAnalysisSummary | undefined =
    contentAnalysis === undefined
      ? undefined
      : {
          contentAnalysisId: contentAnalysis.analysis.id,
          consistency: contentAnalysis.analysis.profileContentConsistency,
          consistencyConfidence: contentAnalysis.analysis.consistencyConfidence,
          activityScore: bundle?.activity.score ?? null,
          contentRelevance: bundle?.relevance.overall ?? null,
          sampledCount: bundle?.sampling.selected.length ?? 0,
          consideredCount: bundle?.sampling.strategy.considered ?? 0,
          modalityNotes: bundle?.multimodal.modalityNotes ?? {},
          visionReason: bundle?.multimodal.plan.reason ?? '',
          reviewReasons,
        };

  return {
    leadId: context.leadId,
    tenantId: context.tenantId,
    analysisId: persisted.analysisId,
    scoreId: persisted.scoreId,
    analysisVersion,
    provider: meta.provider,
    providerKind: input.providerKind,
    evidenceCount: allEvidence.length,
    classifications: mapped.map((m) => m.summary),
    dimensions: dims.dimensions,
    priority: result.priority,
    reviewOutcome,
    finalStatus,
    uncertainFields: uncertain,
    reasons: dims.reasons,
    ...(contentSummary !== undefined ? { contentAnalysis: contentSummary } : {}),
  };
}

/**
 * Builds the versioned content-analysis persistence payload (§13): a new
 * content analysis preserves history (supersession), stays idempotent
 * (deterministic ids) and never duplicates content evidence on retry.
 */
function buildContentAnalysisPersist(
  ctx: AnalysisRunContext,
  context: LeadContext,
  input: CompleteRunInput,
  bundle: ContentIntelBundle,
  analysisVersion: string,
  reviewReasons: string[],
  reviewOutcome: string,
): ContentAnalysisPersist {
  const caId = deterministicUuid('content-analysis', ctx.jobId, context.leadId);
  const outcomeByContent = new Map(bundle.multimodal.outcomes.map((o) => [o.contentId, o]));
  const relevanceByContent = new Map(bundle.relevance.perItem.map((p) => [p.contentId, p]));
  // CAPTION_TEXT evidence id per content id — the citable evidence record.
  const captionEvidenceByContent = new Map<string, string>();
  for (const d of input.evidenceDrafts) {
    if (d.evidenceType !== 'CAPTION_TEXT') continue;
    const contentId = d.metadata['contentId'];
    if (typeof contentId === 'string') captionEvidenceByContent.set(contentId, d.id);
  }

  const items: ContentAnalysisItemDraft[] = bundle.sampling.selected.map((s) => {
    const outcome = outcomeByContent.get(s.content.contentId);
    const rel = relevanceByContent.get(s.content.contentId);
    return {
      id: deterministicUuid('content-analysis-item', caId, s.content.contentId),
      contentAnalysisId: caId,
      leadContentId: s.content.contentId,
      contentType: s.content.contentType,
      selectedReasons: [...s.reasons],
      textAnalyzed: s.content.text !== null,
      imageAnalyzed: outcome?.status === 'ANALYZED',
      mediaAnalyzed: s.content.mediaUrl !== null,
      modalityNotes: {
        text: s.content.text !== null ? 'ANALYZED' : 'UNAVAILABLE',
        vision: outcome?.status ?? (s.content.availability.image ? 'NOT_SELECTED' : 'NO_MEDIA'),
        video: s.content.availability.video ? 'METADATA_ONLY' : 'UNAVAILABLE',
      },
      relevance: rel?.relevance ?? null,
      relevanceSignals: rel?.signals ?? [],
      topics: s.content.topics.slice(0, 20),
    };
  });

  const visionAiRun = bundle.multimodal.aiRun;
  const visionRun: AiRunDraft | undefined = visionAiRun === null
    ? undefined
    : {
        id: deterministicUuid('ai_run', ctx.jobId, context.leadId, 'VISION'),
        provider: visionAiRun.provider,
        providerType: 'VISION',
        model: visionAiRun.model,
        status: visionAiRun.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
        latencyMs: visionAiRun.latencyMs,
        inputHash: sha256Hex(bundle.multimodal.plan.selectedContentIds.join(',')),
        outputHash: sha256Hex(JSON.stringify(bundle.multimodal.observations)),
        promptVersion: visionAiRun.promptVersion,
        schemaVersion: visionAiRun.schemaVersion,
        ...(visionAiRun.error !== undefined ? { error: visionAiRun.error } : {}),
      };

  const consistencyLabel = bundle.consistency.signal.replace('PROFILE_CONTENT_', '');
  const draft: ContentAnalysisDraft = {
    id: caId,
    leadId: context.leadId,
    analysisId: input.analysisId,
    analysisVersion,
    analysisMode: context.analysisMode,
    sampling: {
      strategy: bundle.sampling.strategy,
      selected: bundle.sampling.selected.map((s) => ({
        contentId: s.content.contentId,
        contentType: s.content.contentType,
        reasons: s.reasons,
        evidenceId: captionEvidenceByContent.get(s.content.contentId) ?? s.content.contentId,
      })),
      skipped: bundle.sampling.skipped,
    },
    profileContentConsistency: bundle.consistency.signal,
    consistencyConfidence: bundle.consistency.confidence,
    activitySignals: { ...bundle.activity },
    contentRelevance: bundle.relevance.overall,
    relevanceCriteria: bundle.criteria,
    reviewReasons,
    summary:
      `${bundle.sampling.selected.length}/${bundle.sampling.strategy.considered} content items sampled ` +
      `(${bundle.sampling.strategy.depth}); consistency ${consistencyLabel}; ` +
      `activity ${bundle.activity.score}/100; vision ${bundle.multimodal.modalityNotes['vision'] ?? 'UNAVAILABLE'}; ` +
      `verdict ${reviewOutcome}`,
  };
  return { analysis: draft, items, ...(visionRun !== undefined ? { visionRun } : {}) };
}

/**
 * Validates + applies the evidence-first pass to a provider result.
 * Throws AiSchemaValidationError (bounded repair upstream) on contract drift.
 */
export function enforceResult(
  input: ProfileExtractionInput,
  result: ExtractionResult,
): { profile: StructuredProfile; demoted: string[] } {
  const verdict = validateExtractionOutput(input, result.profile);
  if (!verdict.ok) throw new AiSchemaValidationError(result.meta.provider, verdict.errors);
  const enforced = enforceEvidenceFirst(result.profile, new Set(input.contentSamples.map((s) => s.contentId)));
  return { profile: enforced.profile, demoted: enforced.demoted };
}
