import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AiUnavailableError,
  DeterministicFakeLlmProvider,
  AiProviderError,
  selectAiRuntime,
  loadAiConfig,
  type AiRuntime,
  type LLMProvider,
} from '@ulip/ai';
import {
  AnalysisRunError,
  AnalysisSkipError,
  type AnalysisFlowDeps,
} from '../src/contracts.ts';
import { runAnalysisForLead as runFlow } from '../src/flow.ts';
import {
  LEAD,
  OTHER_TENANT,
  TENANT,
  MemoryAnalysisStore,
  MemoryLifecycle,
  MemoryPolicy,
  makeLeadContext,
  memoryLog,
} from './fakes.ts';

function runtime(llm: LLMProvider | null, status: 'READY' | 'NOT_CONFIGURED' = 'READY'): AiRuntime {
  return {
    status,
    missing: [],
    llm,
    vision: null,
    embedding: null,
    decision: null,
    meta: {
      kind: 'FAKE',
      provider: llm === null ? 'none' : 'fake:deterministic',
      modelVersion: llm === null ? 'unconfigured' : 'fake-1',
      promptVersion: 'fake-deterministic-v1',
      schemaVersion: '1',
    },
    ...(status === 'NOT_CONFIGURED' ? { reason: 'AI runtime not ready' } : {}),
  };
}

interface Scenario {
  deps: AnalysisFlowDeps;
  store: MemoryAnalysisStore;
  lifecycle: MemoryLifecycle;
  policy: MemoryPolicy;
}

function scenario(ai: AiRuntime, initial: 'ANALYSIS_PENDING' | 'ANALYZING' | 'QUALIFIED' = 'ANALYSIS_PENDING'): Scenario {
  const lifecycle = new MemoryLifecycle(initial);
  const store = new MemoryAnalysisStore();
  store.lifecycle = lifecycle;
  store.put(makeLeadContext({ status: initial }));
  const policy = new MemoryPolicy();
  const deps: AnalysisFlowDeps = { log: memoryLog, store, ai, policy, lifecycle };
  return { deps, store, lifecycle, policy };
}

const PAYLOAD = { leadId: LEAD, analysisMode: 'STANDARD', reason: 'test' };
const CTX = { tenantId: TENANT, jobId: '77777777-7777-7777-7777-777777777777', correlationId: null };

test('happy path: ANALYSIS_PENDING → ANALYZING → SCORED → threshold outcome', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()));
  const outcome = await runFlow(s.deps, PAYLOAD, CTX);

  assert.deepEqual(
    s.lifecycle.events.map((e) => `${e.from}:${e.event}→${e.to}`),
    [
      'ANALYSIS_PENDING:ANALYSIS_STARTED→ANALYZING',
      'ANALYZING:ANALYSIS_SUCCEEDED→SCORED',
      `SCORED:THRESHOLD_MAP→${outcome.reviewOutcome}`,
    ],
  );
  assert.equal(['QUALIFIED', 'REVIEW_REQUIRED', 'REJECTED'].includes(outcome.reviewOutcome), true);
  assert.equal(s.lifecycle.statuses.get(LEAD), outcome.finalStatus);

  // Universal business model with taxonomy node ids (not free strings).
  const bt = outcome.classifications.find((c) => c.classificationType === 'BUSINESS_TYPE');
  assert.equal(bt?.taxonomyNodeId, '10000000-0000-0000-0000-000000000001');
  const brand = outcome.classifications.find((c) => c.classificationType === 'BRAND');
  assert.equal(brand?.value, 'HP');
  const city = outcome.classifications.find((c) => c.classificationType === 'OTHER');
  assert.equal(city?.value, 'Tehran');

  // All five score dimensions persisted through the store.
  const run = s.store.runs[0];
  assert.ok(run !== undefined);
  for (const dim of ['relevance', 'audienceQuality', 'activity', 'confidence'] as const) {
    const v: number = run.score[dim];
    assert.equal(typeof v, 'number');
    assert.equal(v >= 0 && v <= 100, true);
  }
  assert.equal(run.score.priority >= 0 && run.score.priority <= 100, true);
  assert.equal(run.score.scoringPolicyVersionId, '50000000-0000-0000-0000-000000000002');

  // Evidence-first: analysis + evidence + ai_run all present.
  assert.ok(s.store.evidence.length >= 3);
  assert.equal(run.evidenceIds.length, s.store.evidence.length);
  assert.equal(run.aiRun.status, 'SUCCESS');
  assert.equal(run.aiRun.provider, 'fake:deterministic');

  // Explainability: structured reasons + uncertainty, no chain-of-thought.
  assert.ok(outcome.reasons.length > 0);
  assert.equal(
    outcome.reasons.some((r) => r.dimension === 'activity'),
    true,
  );
  assert.equal(Array.isArray(outcome.uncertainFields), true);

  // Exactly one current analysis + one current score per lead.
  assert.equal(s.store.currentAnalysis.get(LEAD), outcome.analysisId);
  assert.equal(s.store.currentScore.get(LEAD), outcome.scoreId);
});

test('re-running the same job does not create duplicate current records', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()));
  const first = await runFlow(s.deps, PAYLOAD, CTX);
  await assert.rejects(() => runFlow(s.deps, PAYLOAD, CTX), AnalysisSkipError);
  assert.equal(s.store.runs.length, 1);
  assert.equal(s.store.currentAnalysis.get(LEAD), first.analysisId);
  assert.equal(s.store.currentScore.get(LEAD), first.scoreId);
});

test('a NEW job supersedes the previous analysis instead of overwriting it', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()));
  const first = await runFlow(s.deps, PAYLOAD, CTX);
  // Simulate REPROCESS back into ANALYSIS_PENDING for a second job.
  s.lifecycle.statuses.set(LEAD, 'ANALYSIS_PENDING');
  const second = await runFlow(s.deps, PAYLOAD, { ...CTX, jobId: '88888888-8888-8888-8888-888888888888' });
  assert.notEqual(first.analysisId, second.analysisId);
  assert.equal(s.store.runs.length, 2);
  assert.equal(s.store.currentAnalysis.get(LEAD), second.analysisId);
  assert.equal(s.store.currentRunsFor(LEAD).length, 2); // history preserved
});

test('NOT_CONFIGURED fails before ANALYZING and never fabricates a result', async () => {
  const s = scenario(runtime(null, 'NOT_CONFIGURED'));
  const err = await runFlow(s.deps, PAYLOAD, CTX).catch((e: unknown) => e);
  assert.ok(err instanceof AnalysisRunError);
  assert.equal(err.code, 'AI_UNAVAILABLE');
  assert.equal(err.leadTransitioned, false);
  assert.equal(s.lifecycle.events.length, 0);
  assert.equal(s.lifecycle.statuses.get(LEAD), 'ANALYSIS_PENDING');
  assert.equal(s.store.runs.length, 0);
  assert.ok(err.message.includes('NOT_CONFIGURED'));
});

test('lead missing in tenant is a terminal input error', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()));
  const err = await runFlow(s.deps, PAYLOAD, { ...CTX, tenantId: OTHER_TENANT }).catch((e: unknown) => e);
  assert.ok(err instanceof AnalysisRunError);
  assert.equal(err.code, 'INVALID_DATA');
  assert.equal(s.lifecycle.events.length, 0);
});

test('a lead that is already terminal is SKIPPED, not failed', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()), 'QUALIFIED');
  await assert.rejects(() => runFlow(s.deps, PAYLOAD, CTX), AnalysisSkipError);
  assert.equal(s.store.runs.length, 0);
});

test('provider outage falls back to the deterministic rules engine', async () => {
  const failing: LLMProvider = {
    async extractStructuredProfile() {
      throw new AiProviderError('http:test', '503 from provider', { status: 503 });
    },
    async parseSearchQuery() {
      throw new AiProviderError('http:test', 'unreachable');
    },
    async summarize() {
      throw new AiProviderError('http:test', 'unreachable');
    },
  };
  const s = scenario(runtime(failing));
  const outcome = await runFlow(s.deps, PAYLOAD, CTX);
  assert.equal(outcome.providerKind, 'RULES_FALLBACK');
  assert.equal(outcome.provider, 'rules:fallback');
  const run = s.store.runs[0];
  assert.equal(run?.classifications[0]?.source, 'RULE');
  assert.equal(run?.aiRun.providerType, 'OTHER');
  assert.equal(['QUALIFIED', 'REVIEW_REQUIRED', 'REJECTED'].includes(outcome.reviewOutcome), true);
});

test('mid-run AI unavailability moves the lead to REVIEW_REQUIRED', async () => {
  const unavailable: LLMProvider = {
    async extractStructuredProfile() {
      throw new AiUnavailableError('http:test', 'provider refused');
    },
    async parseSearchQuery() {
      throw new AiUnavailableError('http:test', 'provider refused');
    },
    async summarize() {
      throw new AiUnavailableError('http:test', 'provider refused');
    },
  };
  const s = scenario(runtime(unavailable));
  const err = await runFlow(s.deps, PAYLOAD, CTX).catch((e: unknown) => e);
  assert.ok(err instanceof AnalysisRunError);
  assert.equal(err.action, 'REVIEW');
  assert.equal(s.lifecycle.statuses.get(LEAD), 'REVIEW_REQUIRED');
});

test('parse rejects a malformed payload as an input error', async () => {
  const s = scenario(runtime(new DeterministicFakeLlmProvider()));
  const err = await runFlow(s.deps, {}, CTX).catch((e: unknown) => e);
  assert.ok(err instanceof AnalysisRunError);
  assert.equal(err.code, 'INVALID_DATA');
});

test('runtime selection and flow agree: a configured fake runs end to end', async () => {
  const cfg = loadAiConfig({ AI_PROVIDER: 'fake', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const ai = selectAiRuntime(cfg);
  assert.equal(ai.status, 'READY');
  const s = scenario(ai);
  const outcome = await runFlow(s.deps, PAYLOAD, CTX);
  assert.equal(outcome.providerKind, 'FAKE');
});
