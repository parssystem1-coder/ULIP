import type { AiMetadata, StructuredProfile } from '@ulip/ai';
import {
  AiSchemaValidationError,
  enforceEvidenceFirst,
  validateExtractionOutput,
  type ExtractionResult,
  type ProfileExtractionInput,
} from '@ulip/ai';
import { score } from '@ulip/scoring';
import type { AnalysisOutcome, AnalysisFlowDeps, AnalysisRunContext, EvidenceDraft, LeadContext } from './contracts.ts';
import { computeDimensions } from './dimensions.ts';
import { deterministicUuid, sha256Hex } from './ids.ts';
import { analysisMeta, buildUniversalModel, composeSummary, mapClassifications } from './profile.ts';

export interface CompleteRunInput {
  deps: AnalysisFlowDeps;
  ctx: AnalysisRunContext;
  context: LeadContext;
  analysisId: string;
  profile: StructuredProfile;
  meta: AiMetadata;
  providerKind: 'HTTP' | 'FAKE' | 'RULES_FALLBACK';
  evidenceDrafts: readonly EvidenceDraft[];
  demoted: string[];
  startedAt: Date;
  latencyMs: number;
}

/** Scoring → one transaction → SCORED → THRESHOLD_MAP (policy-owned). */
export async function completeRun(input: CompleteRunInput): Promise<AnalysisOutcome> {
  const { deps, ctx, context, profile, meta } = input;
  const source = input.providerKind === 'RULES_FALLBACK' ? 'RULE' : 'AI';

  const { mapped } = mapClassifications(context.taxonomy, profile, meta.modelVersion, source);
  const policy = await deps.policy.resolveOrBootstrap(context.tenantId);
  const dims = computeDimensions({ profile, evidence: input.evidenceDrafts, context });
  const policyLabel = `v${policy.version}/${policy.versionId.slice(0, 8)}`;
  const result = score(dims.dimensions, policy, policyLabel);

  const universal = buildUniversalModel(profile, context.taxonomy, mapped);
  const summary = composeSummary(context, universal, result.reviewOutcome);

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
    evidenceRefs: input.evidenceDrafts.map((d) => d.id),
    meta: analysisMeta(meta, input.providerKind, ctx.jobId, context.analysisMode),
  };

  const analysisVersion = `${meta.schemaVersion}.${meta.promptVersion}.${meta.modelVersion}.${ctx.jobId.slice(0, 8)}`;
  const scoreId = deterministicUuid('score', ctx.jobId, context.leadId);
  const quality = dims.dimensions.audienceQuality;
  const aqReasons = dims.reasons.filter((r) => r.dimension === 'audienceQuality');

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
    evidenceIds: input.evidenceDrafts.map((d) => d.id),
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
    to: result.reviewOutcome,
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
    reviewOutcome: result.reviewOutcome,
    supersededAnalysisId: persisted.supersededAnalysisId,
  });

  return {
    leadId: context.leadId,
    tenantId: context.tenantId,
    analysisId: persisted.analysisId,
    scoreId: persisted.scoreId,
    analysisVersion,
    provider: meta.provider,
    providerKind: input.providerKind,
    evidenceCount: input.evidenceDrafts.length,
    classifications: mapped.map((m) => m.summary),
    dimensions: dims.dimensions,
    priority: result.priority,
    reviewOutcome: result.reviewOutcome,
    finalStatus,
    uncertainFields: uncertain,
    reasons: dims.reasons,
  };
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
