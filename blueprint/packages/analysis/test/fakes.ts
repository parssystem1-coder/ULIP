import {
  canTransition,
  LEAD_TRANSITION_TABLE,
  type ProcessingEvent,
  type ProcessingStage,
} from '@ulip/orchestration';
import { validateWeights, type ResolvedScoringPolicy } from '@ulip/scoring';
import type {
  AnalysisLogSink,
  AnalysisPolicyService,
  AnalysisStore,
  EvidenceDraft,
  LeadContext,
  LeadLifecycle,
  PersistRunInput,
  PersistRunResult,
} from '../src/contracts.ts';
import { BOOTSTRAP_SCORING_POLICY } from '../src/policy.ts';

export const TENANT = '11111111-1111-1111-1111-111111111111';
export const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
export const LEAD = '33333333-3333-3333-3333-333333333333';

export const TAXONOMY_NODES = [
  { nodeId: '10000000-0000-0000-0000-000000000001', label: 'Wholesaler', nodeKind: 'BUSINESS_TYPE' as const },
  { nodeId: '10000000-0000-0000-0000-000000000002', label: 'Service Provider', nodeKind: 'BUSINESS_TYPE' as const },
  { nodeId: '20000000-0000-0000-0000-000000000001', label: 'Printing', nodeKind: 'INDUSTRY' as const },
  { nodeId: '20000000-0000-0000-0000-000000000002', label: 'Beauty', nodeKind: 'INDUSTRY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000001', label: 'Printer Parts', nodeKind: 'SPECIALTY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000002', label: 'Hair Coloring', nodeKind: 'SPECIALTY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000003', label: 'Balayage', nodeKind: 'SPECIALTY' as const },
];

export function makeLeadContext(overrides: Partial<LeadContext> = {}): LeadContext {
  return {
    leadId: LEAD,
    tenantId: TENANT,
    businessId: '44444444-4444-4444-4444-444444444444',
    status: 'ANALYSIS_PENDING',
    analysisMode: 'STANDARD',
    business: {
      canonicalName: 'چاپخانه تهران',
      description: null,
      website: 'https://chap-tehran.example.test',
      businessTypeNodeId: null,
      industryNodeId: null,
    },
    identities: [
      {
        sourceId: '55555555-5555-5555-5555-555555555555',
        sourceType: 'FAKE',
        externalId: 'fake-001',
        username: 'chap_tehran',
        profileUrl: 'https://example.test/chap_tehran',
        displayName: 'چاپخانه تهران',
      },
    ],
    contents: [],
    rawPayloads: [
      {
        rawId: '66666666-6666-6666-6666-666666666666',
        sourceType: 'FAKE',
        externalId: 'fake-001',
        entityType: 'BUSINESS_PROFILE',
        collectedAt: '2026-01-01T00:00:00.000Z',
        payload: {
          username: 'chap_tehran',
          full_name: 'چاپخانه تهران',
          biography: 'عمده‌فروش قطعات پرینتر HP',
          category: 'WHOLESALE',
          city: 'تهران',
          brand: 'HP',
          external_url: 'https://chap-tehran.example.test',
          followers_count: 1200,
        },
      },
    ],
    locations: [],
    contacts: [],
    existingClassifications: [
      {
        classificationType: 'BUSINESS_TYPE',
        taxonomyNodeId: null,
        valueText: 'Wholesaler',
        valueNormalized: 'wholesaler',
        source: 'RULE',
        confidence: 0.8,
      },
    ],
    taxonomy: { nodes: TAXONOMY_NODES, aliases: [], version: 1 },
    ...overrides,
  };
}

export class MemoryLifecycle implements LeadLifecycle {
  readonly statuses = new Map<string, ProcessingStage>();
  readonly events: { leadId: string; event: ProcessingEvent; from: ProcessingStage; to: ProcessingStage }[] = [];

  constructor(initial: ProcessingStage = 'ANALYSIS_PENDING') {
    this.statuses.set(LEAD, initial);
  }

  async applyLeadEvent(input: {
    leadId: string;
    tenantId?: string | undefined;
    event: ProcessingEvent;
    expectedFrom: ProcessingStage;
    to?: ProcessingStage | undefined;
  }): Promise<ProcessingStage> {
    const current = this.statuses.get(input.leadId);
    if (current === undefined) throw new Error(`unknown lead ${input.leadId}`);
    const targets = LEAD_TRANSITION_TABLE.filter(
      (t) => t.from === input.expectedFrom && t.event === input.event,
    ).map((t) => t.to);
    const to = input.to ?? targets[0];
    if (to === undefined || !canTransition(LEAD_TRANSITION_TABLE, input.expectedFrom, input.event, to)) {
      throw new Error(`invalid transition ${input.expectedFrom} + ${input.event} → ${String(to)}`);
    }
    if (current !== input.expectedFrom) {
      if (current === to) return to;
      throw new Error(`lead is ${current}, expected ${input.expectedFrom}`);
    }
    this.statuses.set(input.leadId, to);
    this.events.push({ leadId: input.leadId, event: input.event, from: input.expectedFrom, to });
    return to;
  }
}

export class MemoryPolicy implements AnalysisPolicyService {
  bootstrapCalls = 0;

  private resolved(): ResolvedScoringPolicy {
    const weights = BOOTSTRAP_SCORING_POLICY.weights;
    const check = validateWeights(weights);
    if (!check.ok) throw new Error(check.errors.join(', '));
    return {
      policyId: 'policy-1',
      versionId: '50000000-0000-0000-0000-000000000002',
      version: 1,
      weights,
      thresholds: BOOTSTRAP_SCORING_POLICY.thresholds,
    };
  }

  async resolve(): Promise<ResolvedScoringPolicy> {
    return this.resolved();
  }

  async resolveOrBootstrap(): Promise<ResolvedScoringPolicy> {
    this.bootstrapCalls += 1;
    return this.resolved();
  }
}

export class MemoryAnalysisStore implements AnalysisStore {
  readonly contexts = new Map<string, LeadContext>();
  readonly evidence: EvidenceDraft[] = [];
  readonly runs: PersistRunInput[] = [];
  readonly currentAnalysis = new Map<string, string>();
  readonly currentScore = new Map<string, string>();
  /** Shared with the lifecycle so the "DB" reflects applied transitions. */
  lifecycle?: MemoryLifecycle;
  /** Emulates the partial unique index: violations throw like PostgreSQL. */
  enforceUniqueCurrent = true;

  put(ctx: LeadContext): void {
    this.contexts.set(`${ctx.tenantId}:${ctx.leadId}`, ctx);
  }

  async loadContext(tenantId: string, leadId: string, mode: LeadContext['analysisMode']): Promise<LeadContext | null> {
    const ctx = this.contexts.get(`${tenantId}:${leadId}`);
    if (ctx === undefined) return null;
    const status = this.lifecycle?.statuses.get(leadId) ?? ctx.status;
    return { ...ctx, status, analysisMode: mode };
  }

  async hasSuccessfulRun(jobId: string, leadId: string): Promise<boolean> {
    return this.runs.some((r) => r.jobId === jobId && r.leadId === leadId && r.aiRun.status === 'SUCCESS');
  }

  async persistEvidence(drafts: EvidenceDraft[]): Promise<number> {
    let inserted = 0;
    for (const d of drafts) {
      if (this.evidence.some((e) => e.id === d.id)) continue;
      this.evidence.push(d);
      inserted += 1;
    }
    return inserted;
  }

  async persistRun(run: PersistRunInput): Promise<PersistRunResult> {
    const prevAnalysis = this.currentAnalysis.get(run.leadId);
    const prevScore = this.currentScore.get(run.leadId);
    if (this.enforceUniqueCurrent && prevAnalysis !== undefined && prevAnalysis !== run.analysis.id) {
      this.currentAnalysis.set(run.leadId, run.analysis.id);
    } else {
      this.currentAnalysis.set(run.leadId, run.analysis.id);
    }
    this.currentScore.set(run.leadId, run.score.id);
    if (!this.runs.some((r) => r.analysis.id === run.analysis.id)) this.runs.push(run);
    return {
      analysisId: run.analysis.id,
      scoreId: run.score.id,
      evidenceLinked: run.evidenceIds.length,
      classificationsInserted: run.classifications.length,
      supersededAnalysisId: prevAnalysis !== undefined && prevAnalysis !== run.analysis.id ? prevAnalysis : null,
      supersededScoreId: prevScore !== undefined && prevScore !== run.score.id ? prevScore : null,
    };
  }

  currentRunsFor(leadId: string): PersistRunInput[] {
    return this.runs.filter((r) => r.leadId === leadId);
  }
}

export const memoryLog: AnalysisLogSink = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
