/**
 * Evaluation runner (Phase 17 §3, §6, §7).
 *
 * Executes ONE arm over the dataset through the REAL evidence pipeline:
 * EvalCase → LeadContext → buildEvidenceDrafts (analysis) → ProfileExtraction
 * (@ulip/ai provider under test) → dimension computation + policy scoring.
 * Providers never see the expected labels; the fake provider is deterministic
 * so runs are reproducible. When the required providers are not configured the
 * arm is recorded NOT_CONFIGURED with zero cases — never fabricated (§6).
 */

import { deterministicUuid, BOOTSTRAP_SCORING_POLICY } from '@ulip/analysis';
import { buildEvidenceDrafts, evidenceSamples, profileText } from '@ulip/analysis';
import type { LeadContext } from '@ulip/analysis';
import type {
  Availability,
} from '@ulip/domain/contracts';
import type { ProcessingStage } from '@ulip/orchestration';
import { aliasKey } from '@ulip/domain';
import type {
  CityPrediction,
  FieldPrediction,
  LLMProvider,
  StructuredProfile,
  TaxonomyOption,
} from '@ulip/ai';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionOption,
  DecisionContext,
  DecisionFact,
} from '@ulip/ai';
import { computeDimensions } from '@ulip/analysis';
import { score, type ResolvedScoringPolicy } from '@ulip/scoring';
import type {
  EvalArmAvailability,
  EvalArmId,
  EvalCase,
  EvalCaseResult,
  EvalDataset,
  EvalErrorCategory,
  EvalDimension,
  EvalLabelOutcome,
  EvalRunMetrics,
  EvalRunRecord,
  EvalVersions,
} from './contracts.ts';
import { EVAL_DIMENSIONS } from './contracts.ts';
import { expectedLabelsFor } from './dataset.ts';
import {
  answerFromProfile,
  answerFromRules,
  armAvailability,
  buildExtractionInput,
  mergeRulesThenLlm,
  runLlmExtraction,
  runRules,
  type ArmAnswer,
  type Prediction,
  type RulesTable,
} from './arms.ts';
import { classifyError, errorDetail, refineWithTaxonomyContext } from './errors.ts';
import { aggregateRunMetrics } from './metrics.ts';

// ---------------------------------------------------------------------------
// Deterministic identifiers and policy
// ---------------------------------------------------------------------------

const EVAL_TENANT_DEFAULT = '00000000-0000-0000-0000-000000000001';

export function evalRunId(versions: EvalVersions, arm: EvalArmId, tenantId: string): string {
  return deterministicUuid(
    'eval-run',
    tenantId,
    versions.datasetVersion,
    arm,
    versions.provider,
    versions.model,
    versions.promptVersion,
    versions.schemaVersion,
    String(versions.taxonomyVersion),
    versions.scoringPolicyVersion,
  );
}

const BOOTSTRAP_POLICY: ResolvedScoringPolicy = {
  policyId: '00000000-0000-0000-0000-0000000000p1',
  versionId: '00000000-0000-0000-0000-0000000000p1',
  version: 1,
  weights: BOOTSTRAP_SCORING_POLICY.weights,
  thresholds: BOOTSTRAP_SCORING_POLICY.thresholds,
};

// ---------------------------------------------------------------------------
// Runner options
// ---------------------------------------------------------------------------

export interface EvalRunnerOptions {
  dataset: EvalDataset;
  arm: EvalArmId;
  /** LLM provider under test (fake, mocked HTTP, or live); null = unavailable. */
  llm: LLMProvider | null;
  /** Optional Jev/DecisionProvider — the runner never instantiates one. */
  decision?: DecisionProvider | undefined;
  tenantId?: string | undefined;
  policy?: ResolvedScoringPolicy | undefined;
  /** Clock injection for tests; defaults to wall clock (latency only). */
  now?: (() => Date) | undefined;
}

interface LlmMeta {
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
}

const RULES_VERSIONS = {
  provider: 'rules',
  model: 'alias-rules-v1',
  promptVersion: 'rules-alias-v1',
  schemaVersion: '1',
};

// ---------------------------------------------------------------------------
// Lead context synthesis (mirrors analysis.loadContext, from dataset facts)
// ---------------------------------------------------------------------------

function leadContextFor(caseItem: EvalCase, dataset: EvalDataset, now: Date): LeadContext {
  const caseId = caseItem.caseId;
  const leadId = deterministicUuid('eval-lead', caseId);
  const businessId = deterministicUuid('eval-business', caseId);
  const analysisId = deterministicUuid('eval-analysis', caseId);
  const sourceId = deterministicUuid('eval-source', caseId);
  const rawId = deterministicUuid('eval-raw', caseId);
  const collectedAt = now.toISOString();

  const contents: LeadContext['contents'] = (caseItem.input.posts ?? []).map((p, i) => ({
    id: deterministicUuid('eval-content', caseId, String(i)),
    contentType: 'POST',
    text: p.text,
    mediaUrl: null,
    publishedAt: p.daysAgo !== undefined ? new Date(now.getTime() - p.daysAgo * 86_400_000).toISOString() : null,
    retrievedAt: collectedAt,
    metadata: {},
  }));

  const locations: LeadContext['locations'] =
    caseItem.input.city === undefined
      ? []
      : [{
          country: caseItem.input.country ?? 'IR',
          province: null,
          city: caseItem.input.city,
          district: null,
          rawValue: caseItem.input.city,
          availability: 'AVAILABLE' as Availability,
          confidence: 0.95,
        }];

  const contacts: LeadContext['contacts'] = (caseItem.input.contactChannels ?? []).map((kind) => ({
    kind,
    availability: 'AVAILABLE' as Availability,
    isSensitive: false,
  }));

  const payload: Record<string, unknown> = {};
  if (caseItem.input.bio !== undefined) payload['biography'] = caseItem.input.bio;
  if (caseItem.input.city !== undefined) payload['city'] = caseItem.input.city;
  if (caseItem.input.website !== undefined) payload['website'] = caseItem.input.website;
  if (caseItem.input.followers !== undefined) payload['followers_count'] = caseItem.input.followers;
  if (caseItem.input.postsCount !== undefined) payload['posts_count'] = caseItem.input.postsCount;
  if (caseItem.input.categories !== undefined) payload['category'] = caseItem.input.categories.join(', ');
  if (caseItem.input.posts !== undefined) {
    payload['posts'] = caseItem.input.posts.map((p) => ({ text: p.text }));
  }

  return {
    leadId,
    tenantId: deterministicUuid('eval-tenant', caseId),
    businessId,
    status: 'ANALYZING' as ProcessingStage,
    analysisMode: 'STANDARD',
    business: {
      canonicalName: caseItem.input.name,
      description: caseItem.input.bio ?? null,
      website: caseItem.input.website ?? null,
      businessTypeNodeId: null,
      industryNodeId: null,
    },
    identities: [
      {
        sourceId,
        sourceType: caseItem.input.sourceType ?? 'FAKE',
        externalId: caseItem.input.externalId ?? `eval-${caseId}`,
        username: caseItem.input.username ?? null,
        profileUrl: null,
        displayName: caseItem.input.displayName ?? null,
      },
    ],
    contents,
    rawPayloads: [
      {
        rawId,
        sourceType: caseItem.input.sourceType ?? 'FAKE',
        externalId: caseItem.input.externalId ?? `eval-${caseId}`,
        entityType: 'PROFILE',
        collectedAt,
        payload,
      },
    ],
    locations,
    contacts,
    existingClassifications: [],
    taxonomy: {
      nodes: dataset.taxonomySnapshot,
      aliases: dataset.taxonomyAliases
        .filter((a) => a.kind !== 'BRAND')
        .flatMap((a) =>
          a.aliases.map((alias) => {
            const node = dataset.taxonomySnapshot.find((n) => n.label === a.label);
            return { nodeId: node?.nodeId ?? '', aliasNorm: aliasKey(alias) };
          }),
        )
        .filter((a) => a.nodeId !== ''),
      version: dataset.taxonomyVersion,
    },
  };
}

// ---------------------------------------------------------------------------
// Profile synthesis (labels → the provider contract shape, with real evidence)
// ---------------------------------------------------------------------------

function nodeIdFor(dataset: EvalDataset, label: string): string | null {
  const key = aliasKey(label);
  return dataset.taxonomySnapshot.find((n) => aliasKey(n.label) === key)?.nodeId ?? null;
}

function fieldPrediction(
  label: string,
  confidence: number,
  evidenceIds: readonly string[],
): FieldPrediction {
  return { value: label, confidence, evidenceIds: [...evidenceIds], availability: 'AVAILABLE' };
}

function profileFromAnswer(answer: ArmAnswer): StructuredProfile {
  const profile: StructuredProfile = { specialties: [] };
  if (answer.businessType.labels.length > 0 && answer.businessType.confidence !== null) {
    profile.businessType = fieldPrediction(answer.businessType.labels[0] ?? '', answer.businessType.confidence, answer.businessType.evidenceIds);
  }
  if (answer.industry.labels.length > 0 && answer.industry.confidence !== null) {
    profile.industry = fieldPrediction(answer.industry.labels[0] ?? '', answer.industry.confidence, answer.industry.evidenceIds);
  }
  profile.specialties = answer.specialty.labels.map((label, i) =>
    fieldPrediction(label, answer.specialty.confidence ?? 0.8, answer.specialty.evidenceIds),
  );
  const subSpecialties = answer.subSpecialty.labels.map((label, i) =>
    fieldPrediction(label, answer.subSpecialty.confidence ?? 0.8, answer.subSpecialty.evidenceIds),
  );
  if (subSpecialties.length > 0) profile.specialties.push(...subSpecialties);
  profile.brands = answer.brand.labels.map((label) =>
    fieldPrediction(label, answer.brand.confidence ?? 0.85, answer.brand.evidenceIds),
  );
  if (answer.location.labels.length > 0 && answer.location.confidence !== null) {
    const city: CityPrediction = {
      ...fieldPrediction(answer.location.labels[0] ?? '', answer.location.confidence, answer.location.evidenceIds),
      provenance: 'EXPLICIT',
    };
    profile.city = city;
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Snapshot label map (node id → label for resolving provider values)
// ---------------------------------------------------------------------------

function snapshotLabelMap(snapshot: readonly TaxonomyOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of snapshot) map.set(node.nodeId, node.label);
  return map;
}

// ---------------------------------------------------------------------------
// Decision-provider refinement (Jev arms)
// ---------------------------------------------------------------------------

interface DecisionLike {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

function buildDecisionRequest(
  question: string,
  candidates: string[],
  facts: DecisionFact[],
): DecisionRequest {
  const options: DecisionOption[] = candidates.map((label) => ({ id: label, label }));
  const context: DecisionContext = { taskType: 'CLASSIFICATION', facts };
  return { question, options, context };
}

/**
 * Refines candidate labels through a DecisionProvider. Candidates are the
 * union of LLM and rules answers per dimension; the provider picks one and
 * its probability becomes the confidence (bounded, thresholded, auditable).
 */
export async function refineWithDecisionProvider(
  llmAnswer: ArmAnswer,
  rulesAnswer: ArmAnswer,
  decision: DecisionLike,
  samples: readonly { text?: string }[],
  lowConfidenceThreshold = 0.8,
): Promise<ArmAnswer> {
  const facts: DecisionFact[] = samples.slice(0, 3).map((s, i) => ({ kind: 'content', value: s.text ?? '', confidence: 1 - i * 0.1 }));
  const refine = async (dimension: string, llmP: Prediction, rulesP: Prediction): Promise<Prediction> => {
    const candidates = [...new Set([...llmP.labels, ...rulesP.labels])];
    if (candidates.length <= 1) return llmP.labels.length > 0 ? llmP : rulesP;
    const uncertain = llmP.confidence === null || llmP.confidence < lowConfidenceThreshold;
    if (!uncertain && llmP.labels[0] === rulesP.labels[0]) return llmP;
    const response = await decision.decide(
      buildDecisionRequest(`Which ${dimension} applies to this business?`, candidates, facts),
    );
    const selected = response.selectedOptionId ?? response.probabilities[0]?.optionId;
    const probability = response.probabilities.find((p) => p.optionId === selected)?.probability ?? 0;
    if (selected === undefined || probability < 0.5) {
      return { labels: [], confidence: probability > 0 ? probability : null, evidenceIds: [] };
    }
    const evidenceIds = selected === rulesP.labels[0] ? rulesP.evidenceIds : llmP.evidenceIds;
    return { labels: [selected], confidence: probability, evidenceIds };
  };

  return {
    businessType: await refine('businessType', llmAnswer.businessType, rulesAnswer.businessType),
    industry: await refine('industry', llmAnswer.industry, rulesAnswer.industry),
    specialty: await refine('specialty', llmAnswer.specialty, rulesAnswer.specialty),
    subSpecialty: await refine('subSpecialty', llmAnswer.subSpecialty, rulesAnswer.subSpecialty),
    brand: await refine('brand', llmAnswer.brand, rulesAnswer.brand),
    location: await refine('location', llmAnswer.location, rulesAnswer.location),
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runEvaluation(options: EvalRunnerOptions): Promise<EvalRunRecord> {
  return (await runEvaluationDetailed(options)).record;
}

/** Same as runEvaluation but also returns the per-case results (for persistence). */
export async function runEvaluationDetailed(options: EvalRunnerOptions): Promise<{
  record: EvalRunRecord;
  results: EvalCaseResult[];
}> {
  const { dataset, arm } = options;
  const llmReady = options.llm !== null;
  const decisionReady = options.decision !== undefined && options.decision !== null;
  const availability: EvalArmAvailability[] = armAvailability({ llmReady, decisionReady });
  const thisArm = availability.find((a) => a.arm === arm);

  const needsLlm = arm !== 'RULES_ONLY';
  const needsDecision = arm === 'LLM_THEN_DECISION_PROVIDER' || arm === 'RULES_LLM_DECISION_PROVIDER';

  const llmMeta: LlmMeta = options.llm === null
    ? RULES_VERSIONS
    : await resolveLlmMeta(options.llm);

  const versions: EvalVersions = {
    datasetVersion: dataset.datasetVersion,
    provider: needsLlm ? llmMeta.provider : RULES_VERSIONS.provider,
    model: needsLlm ? llmMeta.model : RULES_VERSIONS.model,
    promptVersion: needsLlm ? llmMeta.promptVersion : RULES_VERSIONS.promptVersion,
    schemaVersion: needsLlm ? llmMeta.schemaVersion : RULES_VERSIONS.schemaVersion,
    taxonomyVersion: dataset.taxonomyVersion,
    scoringPolicyVersion: `bootstrap-v${options.policy?.version ?? BOOTSTRAP_POLICY.version}`,
  };

  const now = options.now ?? (() => new Date());
  const runId = evalRunId(versions, arm, options.tenantId ?? EVAL_TENANT_DEFAULT);
  const startedAt = now().toISOString();

  if (thisArm === undefined) {
    return { record: notConfiguredRecord(runId, versions, arm, `unknown arm: ${arm}`, startedAt, now), results: [] };
  }
  if (thisArm.status === 'NOT_CONFIGURED') {
    return { record: notConfiguredRecord(runId, versions, arm, thisArm.reason ?? 'providers not configured', startedAt, now), results: [] };
  }
  if (needsLlm && options.llm === null) {
    return { record: notConfiguredRecord(runId, versions, arm, 'LLM provider required for this arm', startedAt, now), results: [] };
  }
  if (needsDecision && !decisionReady) {
    return { record: notConfiguredRecord(runId, versions, arm, 'DecisionProvider (Jev) required for this arm', startedAt, now), results: [] };
  }

  const rulesTable: RulesTable = {
    taxonomyAliases: dataset.taxonomyAliases,
    locationAliases: dataset.locationAliases,
    snapshot: dataset.taxonomySnapshot,
  };
  const labelMap = snapshotLabelMap(dataset.taxonomySnapshot);
  const policy = options.policy ?? BOOTSTRAP_POLICY;
  const tenantId = options.tenantId ?? EVAL_TENANT_DEFAULT;

  const results: EvalCaseResult[] = [];
  let armFailure: string | null = null;

  for (const caseItem of dataset.cases) {
    const ctx = leadContextFor(caseItem, dataset, now());
    const drafts = buildEvidenceDrafts(ctx.leadId, deterministicUuid('eval-analysis', caseItem.caseId), ctx, now());
    const input = buildExtractionInput(caseItem);
    const extractionInput = {
      ...input,
      contentSamples: evidenceSamples(drafts),
      profileText: profileText(drafts),
      taxonomySnapshot: dataset.taxonomySnapshot,
    };

    let llmAnswer: ArmAnswer = emptyAnswer();
    let rulesAnswer = answerFromRules(runRules(caseItem, rulesTable, extractionInput));
    let caseLatencyMs = 0;

    try {
      if (needsLlm && options.llm !== null) {
        const started = Date.now();
        const extraction = await runLlmExtraction(options.llm, extractionInput);
        caseLatencyMs = Date.now() - started;
        llmAnswer = answerFromProfile(extraction.profile, labelMap);
      }

      let finalAnswer: ArmAnswer;
      if (arm === 'RULES_ONLY') {
        finalAnswer = rulesAnswer;
      } else if (arm === 'LLM_ONLY') {
        finalAnswer = llmAnswer;
      } else if (arm === 'RULES_THEN_LLM') {
        finalAnswer = mergeRulesThenLlm(llmAnswer, rulesAnswer);
      } else if (arm === 'LLM_THEN_DECISION_PROVIDER') {
        finalAnswer = await refineWithDecisionProvider(llmAnswer, rulesAnswer, options.decision as DecisionLike, extractionInput.contentSamples);
      } else {
        // RULES_LLM_DECISION_PROVIDER
        const merged = mergeRulesThenLlm(llmAnswer, rulesAnswer);
        finalAnswer = await refineWithDecisionProvider(merged, rulesAnswer, options.decision as DecisionLike, extractionInput.contentSamples);
      }

      const profile = profileFromAnswer(finalAnswer);
      const dimensions = computeDimensions({ profile, evidence: drafts, context: ctx });
      const scoreResult = score(dimensions.dimensions, policy, versions.scoringPolicyVersion);

      const outcomes: EvalLabelOutcome[] = EVAL_DIMENSIONS.map((dim) => {
        const expected = expectedLabelsFor(caseItem, dim);
        const actual = finalAnswer[dimToAnswerKey(dim)].labels;
        const confidence = finalAnswer[dimToAnswerKey(dim)].confidence;
        const correct =
          [...expected].map(aliasKey).sort().join('|') === [...actual].map(aliasKey).sort().join('|');
        return {
          dimension: dim,
          expected,
          actual,
          correct,
          confidence: actual.length > 0 ? confidence : null,
          abstained: expected.length > 0 && actual.length === 0,
        };
      });

      const labeledOutcomes = outcomes.filter((o) => o.expected.length > 0);
      const correctCount = labeledOutcomes.filter((o) => o.correct).length;
      const answeredConf = outcomes
        .filter((o) => o.expected.length > 0 && o.actual.length > 0 && o.confidence !== null)
        .map((o) => o.confidence as number);
      const meanConfidence = answeredConf.length === 0 ? null : answeredConf.reduce((s, c) => s + c, 0) / answeredConf.length;
      const exactMatch = outcomes.every((o) => o.correct);
      const miscalibrated = outcomes.some(
        (o) =>
          o.confidence !== null &&
          o.expected.length > 0 &&
          ((o.confidence >= 0.8 && !o.correct) || (o.confidence < 0.5 && o.correct)),
      );

      const provisional: EvalCaseResult = {
        caseId: caseItem.caseId,
        arm,
        versions,
        outcomes,
        exactMatch,
        dimensionAccuracy: labeledOutcomes.length === 0 ? 1 : correctCount / labeledOutcomes.length,
        meanConfidence,
        miscalibrated,
        reviewOutcome: {
          expected: caseItem.expectedOutcome ?? null,
          actual: scoreResult.reviewOutcome,
          correct: caseItem.expectedOutcome !== undefined && caseItem.expectedOutcome === scoreResult.reviewOutcome,
        },
        scores: {
          relevance: scoreResult.relevance,
          audienceQuality: scoreResult.audienceQuality,
          activity: scoreResult.activity,
          confidence: scoreResult.confidence,
          priority: scoreResult.priority,
        },
        latencyMs: caseLatencyMs,
        tokens: null,
        estimatedCost: null,
        errorCategory: null,
        errorDetail: null,
      };

      const baseCategory = classifyError(caseItem, provisional);
      const category = refineWithTaxonomyContext(baseCategory, caseItem, provisional, (dimension, value) =>
        isCanonicalFor(dataset, dimension, value),
      );
      results.push({
        ...provisional,
        errorCategory: category,
        errorDetail: errorDetail(caseItem, { ...provisional, errorCategory: category }),
      });
    } catch (err) {
      armFailure = `case ${caseItem.caseId}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
  }

  const finishedAt = now().toISOString();
  const armStatus: EvalRunRecord['armStatus'] = armFailure !== null ? 'FAILED' : 'EXECUTED';
  const metrics = aggregateRunMetrics(
    results,
    new Map(dataset.cases.map((c) => [c.caseId, c.tags as unknown as readonly string[]])),
  );

  return {
    record: {
      runId,
      tenantId,
      versions,
      arm,
      armStatus,
      armReason: armFailure,
      startedAt,
      finishedAt,
      metrics,
    },
    results,
  };
}

function dimToAnswerKey(dim: EvalDimension): keyof ArmAnswer {
  return dim as keyof ArmAnswer;
}

function emptyAnswer(): ArmAnswer {
  const mk = (): Prediction => ({ labels: [], confidence: null, evidenceIds: [] });
  return {
    businessType: mk(),
    industry: mk(),
    specialty: mk(),
    subSpecialty: mk(),
    brand: mk(),
    location: mk(),
  };
}

function isCanonicalFor(dataset: EvalDataset, dimension: string, value: string): boolean {
  const kindOf: Record<string, string> = {
    businessType: 'BUSINESS_TYPE',
    industry: 'INDUSTRY',
    specialty: 'SPECIALTY',
    subSpecialty: 'SUB_SPECIALTY',
    brand: 'BRAND',
    location: 'LOCATION',
  };
  const kind = kindOf[dimension];
  if (kind === undefined) return true;
  const key = aliasKey(value);
  if (kind === 'LOCATION') {
    return dataset.locationAliases.some((l) => aliasKey(l.city) === key);
  }
  if (kind === 'BRAND') {
    return dataset.taxonomyAliases.some((a) => a.kind === 'BRAND' && aliasKey(a.label) === key);
  }
  return dataset.taxonomySnapshot.some((n) => n.nodeKind === kind && aliasKey(n.label) === key);
}

async function resolveLlmMeta(llm: LLMProvider): Promise<LlmMeta> {
  // The fake provider exposes metadata(); HTTP providers derive it from config.
  const maybe = llm as LLMProvider & { metadata?: () => { provider: string; modelVersion: string; promptVersion: string; schemaVersion: string } };
  if (typeof maybe.metadata === 'function') {
    const meta = maybe.metadata();
    return {
      provider: meta.provider,
      model: meta.modelVersion,
      promptVersion: meta.promptVersion,
      schemaVersion: meta.schemaVersion,
    };
  }
  return { provider: 'unknown-llm', model: 'unknown', promptVersion: 'unknown', schemaVersion: 'unknown' };
}

function notConfiguredRecord(
  runId: string,
  versions: EvalVersions,
  arm: EvalArmId,
  reason: string,
  startedAt: string,
  now: () => Date,
): EvalRunRecord {
  const metrics = aggregateRunMetrics([], new Map());
  return {
    runId,
    tenantId: EVAL_TENANT_DEFAULT,
    versions,
    arm,
    armStatus: 'NOT_CONFIGURED',
    armReason: reason,
    startedAt,
    finishedAt: now().toISOString(),
    metrics,
  };
}

export { isCanonicalFor };
