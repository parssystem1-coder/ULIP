import {
  AiError,
  AiNotConfiguredError,
  DeterministicFakeLlmProvider,
  type AiMetadata,
  type ProfileExtractionInput,
} from '@ulip/ai';
import { FAILURE_POLICY, type ErrorCode } from '@ulip/orchestration';
import { guessLocale } from '@ulip/domain';
import {
  AnalysisInputError,
  AnalysisRunError,
  AnalysisSkipError,
  type AnalysisFlowDeps,
  type AnalysisJobPayload,
  type AnalysisOutcome,
  type AnalysisRunContext,
  type LeadContext,
} from './contracts.ts';
import { buildEvidenceDrafts, evidenceSamples, profileText } from './evidence.ts';
import { completeRun, enforceResult } from './complete.ts';
import { deterministicUuid } from './ids.ts';
import { ScoringPolicyNotFoundError } from './policy.ts';

export function parseAnalysisPayload(raw: unknown): AnalysisJobPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AnalysisInputError('analysis payload must be an object');
  }
  const leadId = (raw as Record<string, unknown>)['leadId'];
  if (typeof leadId !== 'string' || leadId.trim() === '') {
    throw new AnalysisInputError('payload.leadId is required');
  }
  const mode = (raw as Record<string, unknown>)['analysisMode'];
  const allowed = ['BASIC', 'STANDARD', 'DEEP', 'BE_REUSE'];
  const reason = (raw as Record<string, unknown>)['reason'];
  return {
    leadId,
    analysisMode: typeof mode === 'string' && allowed.includes(mode)
      ? (mode as AnalysisJobPayload['analysisMode'])
      : 'STANDARD',
    reason: typeof reason === 'string' && reason !== '' ? reason : 'manual',
  };
}

function errorCodeOf(err: unknown): ErrorCode {
  if (err instanceof AiError) {
    // NOT_CONFIGURED is not a job-level ErrorCode: it maps to AI_UNAVAILABLE.
    return err.code === 'NOT_CONFIGURED' ? 'AI_UNAVAILABLE' : (err.code as ErrorCode);
  }
  if (err instanceof AnalysisInputError) return 'INVALID_DATA';
  if (err instanceof ScoringPolicyNotFoundError) return 'UNKNOWN';
  return 'UNKNOWN';
}

function asRunError(err: unknown, leadTransitioned: boolean): AnalysisRunError {
  if (err instanceof AnalysisRunError) return err;
  const code = errorCodeOf(err);
  return new AnalysisRunError({
    code,
    action: FAILURE_POLICY[code].action,
    message: err instanceof Error ? err.message : String(err),
    leadTransitioned,
    cause: err,
  });
}

/**
 * Runs ANALYSIS_PENDING → ANALYZING → AI extraction → evidence validation →
 * scoring → SCORED → THRESHOLD_MAP, or applies the existing failure policy.
 *
 * Failure semantics (ADR-016):
 *  - NOT_CONFIGURED is detected BEFORE the ANALYZING transition, so a missing
 *    provider never moves the lead and never fabricates an analysis.
 *  - RETRY  → the lead stays ANALYZING and the worker reschedules the job.
 *  - REVIEW → ANALYSIS_FAILED → REVIEW_REQUIRED (human review, never silent).
 *  - TERMINAL_FAIL → ANALYSIS_FAILED → FAILED (reprocessable via REPROCESS).
 *  - FALLBACK (AI_PROVIDER_ERROR) → deterministic rules-only analysis first;
 *    the result is explicitly labelled RULES_FALLBACK / source RULE.
 */
export async function runAnalysisForLead(
  deps: AnalysisFlowDeps,
  rawPayload: unknown,
  ctx: AnalysisRunContext,
): Promise<AnalysisOutcome> {
  let payload: AnalysisJobPayload;
  try {
    payload = parseAnalysisPayload(rawPayload);
  } catch (err) {
    throw asRunError(err, false);
  }
  const startedAt = (deps.now ?? (() => new Date()))();
  const analysisId = deterministicUuid('analysis', ctx.jobId, payload.leadId);

  const context = await deps.store.loadContext(ctx.tenantId, payload.leadId, payload.analysisMode);
  if (context === null) {
    throw asRunError(new AnalysisInputError(`lead ${payload.leadId} not found in tenant ${ctx.tenantId}`), false);
  }

  if (deps.ai.status !== 'READY' || deps.ai.llm === null) {
    throw asRunError(
      new AiNotConfiguredError(
        deps.ai.meta.provider,
        deps.ai.missing.length > 0 ? deps.ai.missing : [deps.ai.reason ?? 'AI runtime not ready'],
      ),
      false,
    );
  }

  let leadTransitioned = false;
  if (context.status === 'ANALYSIS_PENDING') {
    await deps.lifecycle.applyLeadEvent({
      leadId: context.leadId,
      tenantId: context.tenantId,
      event: 'ANALYSIS_STARTED',
      expectedFrom: 'ANALYSIS_PENDING',
      to: 'ANALYZING',
    });
    leadTransitioned = true;
  } else if (context.status === 'ANALYZING') {
    leadTransitioned = true; // retry/resume of an interrupted attempt
    deps.log.warn('analysis resumed from ANALYZING', { leadId: context.leadId, jobId: ctx.jobId });
  } else {
    throw new AnalysisSkipError(context.status, `lead ${context.leadId} is ${context.status}; analysis not applicable`);
  }

  const drafts = buildEvidenceDrafts(context.leadId, analysisId, context, startedAt);
  const input: ProfileExtractionInput = {
    profileText: profileText(drafts),
    locationHints: context.locations.map((l) => l.rawValue),
    contentSamples: evidenceSamples(drafts),
    taxonomySnapshot: context.taxonomy.nodes,
    locale: guessLocale(profileText(drafts)),
  };

  try {
    deps.progress?.('ANALYSIS', 15);
    const evidenceInserted = await deps.store.persistEvidence(drafts);
    deps.log.info('evidence persisted', {
      jobId: ctx.jobId, leadId: context.leadId, evidence: drafts.length, inserted: evidenceInserted,
    });
    deps.progress?.('EVIDENCE_VALIDATION', 45);

    const t0 = Date.now();
    const result = await deps.ai.llm.extractStructuredProfile(input);
    const latency = Date.now() - t0;
    const { profile, demoted } = enforceResult(input, result);
    deps.progress?.('EVIDENCE_VALIDATION', 65);

    return await completeRun({
      deps, ctx, context, analysisId, profile, meta: result.meta,
      providerKind: deps.ai.meta.kind === 'FAKE' ? 'FAKE' : 'HTTP',
      evidenceDrafts: drafts, demoted, startedAt, latencyMs: latency,
    });
  } catch (err) {
    let runErr = asRunError(err, leadTransitioned);

    if (runErr.action === 'FALLBACK') {
      const fallback = await rulesFallback(deps, ctx, context, analysisId, drafts, input, startedAt);
      if (fallback !== null) return fallback;
      runErr = asRunError(new Error(`${runErr.message} (rules fallback produced no evidence-backed classification)`), leadTransitioned);
      if (runErr.action === 'FALLBACK') {
        runErr = new AnalysisRunError({
          code: runErr.code, action: 'REVIEW', message: runErr.message,
          leadTransitioned, cause: runErr.cause,
        });
      }
    }

    await applyFailureEvent(deps, runErr, context.leadId, context.tenantId);
    throw runErr;
  }
}

/** AI_PROVIDER_ERROR path: deterministic rules-only analysis, honestly labelled. */
async function rulesFallback(
  deps: AnalysisFlowDeps,
  ctx: AnalysisRunContext,
  context: LeadContext,
  analysisId: string,
  drafts: ReturnType<typeof buildEvidenceDrafts>,
  input: ProfileExtractionInput,
  startedAt: Date,
): Promise<AnalysisOutcome | null> {
  const rules = new DeterministicFakeLlmProvider('rules:fallback', 'rules-v1');
  const t0 = Date.now();
  const result = await rules.extractStructuredProfile(input);
  const { profile, demoted } = enforceResult(input, result);
  const claimedAny =
    profile.businessType !== undefined || profile.industry !== undefined ||
    profile.specialties.length > 0 || profile.city !== undefined;
  if (!claimedAny) return null;
  deps.log.warn('AI provider failed; running deterministic rules fallback', {
    jobId: ctx.jobId, leadId: context.leadId,
  });
  const meta: AiMetadata = { ...result.meta, provider: 'rules:fallback', modelVersion: 'rules-v1' };
  return completeRun({
    deps, ctx, context, analysisId, profile, meta,
    providerKind: 'RULES_FALLBACK',
    evidenceDrafts: drafts, demoted, startedAt, latencyMs: Date.now() - t0,
  });
}

/** Applies the policy-mandated lead transition for a failed run. */
async function applyFailureEvent(
  deps: AnalysisFlowDeps,
  runErr: AnalysisRunError,
  leadId: string,
  tenantId: string,
): Promise<void> {
  if (!runErr.leadTransitioned) return;
  if (runErr.action !== 'REVIEW' && runErr.action !== 'TERMINAL_FAIL') return;
  const to = runErr.action === 'REVIEW' ? 'REVIEW_REQUIRED' : 'FAILED';
  try {
    await deps.lifecycle.applyLeadEvent({
      leadId, tenantId, event: 'ANALYSIS_FAILED', expectedFrom: 'ANALYZING', to,
    });
    deps.log.warn('analysis failed → lead transition applied', {
      leadId, jobId: runErr.code, action: runErr.action, to,
    });
  } catch (transErr) {
    deps.log.error('failed to apply failure transition', {
      leadId, error: transErr instanceof Error ? transErr.message : String(transErr),
    });
  }
}
