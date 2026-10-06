/**
 * Multimodal pipeline (Phase 18, ADR-030 §5, §12).
 *
 * Cost-aware routing INSIDE the ANALYZING state:
 *
 *   deterministic signals (intel.ts)
 *     → LLM text/content analysis (the existing extraction call)
 *     → Vision ONLY for selected images (never every media item)
 *     → strong model only when ambiguity requires it (future routing hook)
 *     → REVIEW_REQUIRED when unresolved
 *
 * Vision is OPTIONAL by contract: when no VisionProvider is configured the
 * pipeline continues with the available modalities and records
 * `VISION_UNAVAILABLE` explicitly — the missing result is never fabricated.
 * Image selection is deterministic: media-bearing items, newest first, capped
 * by budget (BASIC 0 / STANDARD 2 / DEEP 4 — Vision is the expensive slot).
 */

import type { AiMetadata, VisionProvider, VisualAnalysis } from '@ulip/ai';
import type { EvidenceDraft } from './contracts.ts';
import type { SampledContent } from './sampling.ts';
import type { SelectionReason } from './sampling.ts';
import { deterministicUuid, sha256Hex } from './ids.ts';

export interface VisionPlan {
  /** Whether any vision call will be attempted this run. */
  enabled: boolean;
  reason: string;
  /** contentIds selected for image analysis (≤ budget, deterministic order). */
  selectedContentIds: string[];
  budget: number;
}

const VISION_BUDGET: Record<'BASIC' | 'STANDARD' | 'DEEP', number> = {
  BASIC: 0,
  STANDARD: 2,
  DEEP: 4,
};

export interface ImageAnalysisOutcome {
  contentId: string;
  /** 'ANALYZED' when the provider returned observations. */
  status: 'ANALYZED' | 'SKIPPED_NO_MEDIA' | 'SKIPPED_NOT_SELECTED' | 'FAILED';
  observations: { label: string; confidence: number }[];
  meta: AiMetadata | null;
}

export interface MultimodalRunResult {
  plan: VisionPlan;
  outcomes: ImageAnalysisOutcome[];
  /** Evidence-worthy observations bound to their content item. */
  observations: { contentId: string; label: string; confidence: number }[];
  /** Structured modality notes for persistence (never claims unanalyzed modalities). */
  modalityNotes: Record<string, string>;
  latencyMs: number;
  aiRun: {
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: string;
    status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    latencyMs: number;
    error?: string | undefined;
  } | null;
}

function publishedTime(c: SampledContent['content']): number {
  if (c.publishedAt === null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(c.publishedAt);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Deterministic vision selection plan. Vision is enabled only when a provider
 * exists, the depth budget is > 0 and at least one sampled item carries media.
 */
export function planVision(
  vision: VisionProvider | null,
  depth: 'BASIC' | 'STANDARD' | 'DEEP',
  sampled: readonly SampledContent[],
): VisionPlan {
  const budget = VISION_BUDGET[depth];
  if (vision === null) {
    return {
      enabled: false,
      reason: 'VISION_UNAVAILABLE: no VisionProvider configured — continuing with available modalities',
      selectedContentIds: [],
      budget,
    };
  }
  if (budget === 0) {
    return {
      enabled: false,
      reason: `VISION_SKIPPED_BY_DEPTH: ${depth} analysis does not include image analysis`,
      selectedContentIds: [],
      budget,
    };
  }
  const mediaItems = sampled
    .filter((s) => s.content.mediaUrl !== null && s.content.availability.image)
    .sort(
      (a, b) =>
        publishedTime(b.content) - publishedTime(a.content) ||
        a.content.contentId.localeCompare(b.content.contentId),
    );
  if (mediaItems.length === 0) {
    return {
      enabled: false,
      reason: 'VISION_SKIPPED_NO_MEDIA: no sampled item carries an image reference',
      selectedContentIds: [],
      budget,
    };
  }
  return {
    enabled: true,
    reason: `VISION_SELECTED: ${Math.min(budget, mediaItems.length)} of ${mediaItems.length} media items (newest first, budget ${budget})`,
    selectedContentIds: mediaItems.slice(0, budget).map((s) => s.content.contentId),
    budget,
  };
}

/**
 * Executes the planned vision step. Every outcome records WHY it is in its
 * state (analyzed / not selected / no media / failed) — modality honesty is
 * part of the persisted result, and a failed image analysis degrades the run
 * gracefully instead of throwing the whole analysis away.
 */
export async function runVisionStep(
  vision: VisionProvider | null,
  plan: VisionPlan,
  sampled: readonly SampledContent[],
  context: string,
): Promise<MultimodalRunResult> {
  const started = Date.now();
  const outcomes: ImageAnalysisOutcome[] = [];
  const selectedSet = new Set(plan.selectedContentIds);

  for (const s of sampled) {
    if (!selectedSet.has(s.content.contentId)) {
      outcomes.push({
        contentId: s.content.contentId,
        status: s.content.mediaUrl === null ? 'SKIPPED_NO_MEDIA' : 'SKIPPED_NOT_SELECTED',
        observations: [],
        meta: null,
      });
    }
  }

  if (!plan.enabled || vision === null) {
    return {
      plan,
      outcomes,
      observations: [],
      modalityNotes: {
        vision: plan.enabled ? 'PLANNED_BUT_UNAVAILABLE' : 'UNAVAILABLE',
        text: sampled.some((s) => s.content.availability.text) ? 'ANALYZED' : 'UNAVAILABLE',
        video: sampled.some((s) => s.content.availability.video) ? 'METADATA_ONLY' : 'UNAVAILABLE',
      },
      latencyMs: Date.now() - started,
      aiRun: null,
    };
  }

  const observations: MultimodalRunResult['observations'] = [];
  let aiRun: MultimodalRunResult['aiRun'] = null;
  let visionError: string | undefined;

  for (const contentId of plan.selectedContentIds) {
    const entry = sampled.find((s) => s.content.contentId === contentId);
    const uri = entry?.content.mediaUrl;
    if (entry === undefined || uri === null || uri === undefined) {
      outcomes.push({ contentId, status: 'SKIPPED_NO_MEDIA', observations: [], meta: null });
      continue;
    }
    try {
      const t0 = Date.now();
      const analysis: VisualAnalysis = await vision.analyzeImage({ uri, context });
      const meta = analysis.meta;
      const valid = analysis.observations.filter(
        (o) => Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1 && o.label.trim() !== '',
      );
      outcomes.push({
        contentId,
        status: 'ANALYZED',
        observations: valid.map((o) => ({ label: o.label, confidence: o.confidence })),
        meta,
      });
      for (const o of valid) observations.push({ contentId, label: o.label, confidence: o.confidence });
      aiRun = {
        provider: meta.provider,
        model: meta.modelVersion,
        promptVersion: meta.promptVersion,
        schemaVersion: meta.schemaVersion,
        status: 'SUCCESS',
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      visionError = err instanceof Error ? err.message : String(err);
      outcomes.push({ contentId, status: 'FAILED', observations: [], meta: null });
      aiRun = {
        provider: 'unknown:vision',
        model: 'unknown',
        promptVersion: 'unknown',
        schemaVersion: 'unknown',
        status: 'FAILED',
        latencyMs: Date.now() - t0Fallback(started),
        ...(visionError !== undefined ? { error: visionError } : {}),
      };
    }
  }

  const anyAnalyzed = outcomes.some((o) => o.status === 'ANALYZED');
  return {
    plan,
    outcomes,
    observations,
    modalityNotes: {
      vision: anyAnalyzed ? 'ANALYZED' : (visionError !== undefined ? 'FAILED' : 'UNAVAILABLE'),
      text: sampled.some((s) => s.content.availability.text) ? 'ANALYZED' : 'UNAVAILABLE',
      video: sampled.some((s) => s.content.availability.video) ? 'METADATA_ONLY' : 'UNAVAILABLE',
    },
    latencyMs: Date.now() - started,
    aiRun,
  };
}

function t0Fallback(started: number): number {
  return started;
}

/**
 * Builds IMAGE_OBSERVATION evidence drafts from the vision outcomes. Each
 * analyzed image yields ONE evidence row citing `lead_contents/{id}#vision`
 * with the observed labels — traceable, provider-stamped, deterministic id
 * (idempotent retries never duplicate rows). Failed/unavailable analyses
 * produce NO fabricated observation rows.
 */
export function buildImageObservationDrafts(
  leadId: string,
  analysisId: string,
  result: MultimodalRunResult,
  now: Date,
): EvidenceDraft[] {
  const drafts: EvidenceDraft[] = [];
  for (const outcome of result.outcomes) {
    if (outcome.status !== 'ANALYZED' || outcome.observations.length === 0) continue;
    const meta = outcome.meta;
    const sourceReference = `lead_contents/${outcome.contentId}#vision`;
    const labels = outcome.observations.map((o) => o.label).join(' | ');
    const contentHash = sha256Hex(
      `IMAGE_OBSERVATION|${sourceReference}|${labels}|${meta?.modelVersion ?? 'unknown'}`,
    );
    const minConfidence = outcome.observations.reduce(
      (min, o) => Math.min(min, o.confidence),
      1,
    );
    drafts.push({
      id: deterministicUuid('evidence', analysisId, 'IMAGE_OBSERVATION', sourceReference, contentHash),
      leadId,
      evidenceType: 'IMAGE_OBSERVATION',
      sourceType: 'PLATFORM',
      sourceReference,
      content: labels,
      contentHash,
      retrievedAt: now.toISOString(),
      confidence: Math.max(0.5, Math.min(0.9, minConfidence)),
      metadata: {
        contentId: outcome.contentId,
        visionProvider: meta?.provider ?? 'unknown:vision',
        visionModel: meta?.modelVersion ?? 'unknown',
        promptVersion: meta?.promptVersion ?? 'unknown',
        schemaVersion: meta?.schemaVersion ?? 'unknown',
        observationCount: outcome.observations.length,
      },
    });
  }
  return drafts;
}

export type { SelectionReason };
