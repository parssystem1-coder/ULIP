/**
 * Runner tests (Phase 17 §6, §7, §16).
 *
 * Uses the deterministic fake provider AND a mocked HTTP provider (injectable
 * fetch) — no network, no credentials, ever.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DeterministicFakeLlmProvider, HttpLlmProvider, type FetchLike } from '@ulip/ai';
import type { DecisionProvider, DecisionRequest, DecisionResponse } from '@ulip/ai';
import type { EvalCaseResult } from '../src/contracts.ts';
import { loadDefaultDataset } from '../src/dataset.ts';
import { runEvaluation, runEvaluationDetailed } from '../src/runner.ts';

const dataset = loadDefaultDataset();

function makeHttpProvider(fetchImpl: FetchLike): HttpLlmProvider {
  return new HttpLlmProvider({
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'sk-test',
    model: 'mock-1',
    timeoutMs: 500,
    maxRetries: 1,
    backoffMs: 0,
    promptVersion: 'mock-p1',
    schemaVersion: '1',
    providerName: 'http:mock',
    fetchImpl,
    sleep: async () => undefined,
  });
}

/** Deterministic Jev stub: always selects the highest-probability option. */
function stubDecisionProvider(): DecisionProvider {
  return {
    name: 'stub:decision',
    async healthCheck() {
      return { ok: true };
    },
    async decide(request: DecisionRequest): Promise<DecisionResponse> {
      const top = [...request.options]
        .map((o, i) => ({ id: o.id, p: 1 - i * 0.1 }))
        .sort((a, b) => b.p - a.p)[0];
      return {
        probabilities: request.options.map((o, i) => ({ optionId: o.id, probability: 1 - i * 0.1 })),
        ...(top !== undefined ? { selectedOptionId: top.id } : {}),
        provider: 'stub:decision',
        modelVersion: 'stub-1',
      };
    },
  };
}

// ------------------------------------------------------------- RULES_ONLY

test('RULES_ONLY executes without any provider and classifies the canonical cases', async () => {
  const run = await runEvaluation({ dataset, arm: 'RULES_ONLY', llm: null });
  assert.equal(run.armStatus, 'EXECUTED');
  assert.equal(run.metrics.totalCases, dataset.cases.length);
  assert.equal(run.versions.provider, 'rules');
  // Canonical cases are fully covered by the alias tables.
  const results = (await runEvaluationDetailed({ dataset, arm: 'RULES_ONLY', llm: null })).results;
  const ev1 = results.find((r) => r.caseId === 'ev-001');
  assert.ok(ev1 !== undefined);
  const bt = ev1.outcomes.find((o) => o.dimension === 'businessType');
  assert.equal(bt?.actual[0], 'Wholesaler');
  const loc = ev1.outcomes.find((o) => o.dimension === 'location');
  assert.equal(loc?.actual[0], 'Tehran');
  const brands = ev1.outcomes.find((o) => o.dimension === 'brand');
  assert.deepEqual([...(brands?.actual ?? [])].sort(), ['Canon', 'Epson', 'HP']);
});

// ------------------------------------------------- unavailable providers

test('LLM arms are NOT_CONFIGURED without a provider (never fabricated)', async () => {
  for (const arm of ['LLM_ONLY', 'RULES_THEN_LLM'] as const) {
    const run = await runEvaluation({ dataset, arm, llm: null });
    assert.equal(run.armStatus, 'NOT_CONFIGURED');
    assert.equal(run.metrics.totalCases, 0);
    assert.match(run.armReason ?? '', /no LLM provider/);
  }
});

test('Jev arms are NOT_CONFIGURED without a DecisionProvider (ADR-017)', async () => {
  for (const arm of ['LLM_THEN_DECISION_PROVIDER', 'RULES_LLM_DECISION_PROVIDER'] as const) {
    const run = await runEvaluation({ dataset, arm, llm: new DeterministicFakeLlmProvider() });
    assert.equal(run.armStatus, 'NOT_CONFIGURED');
    assert.match(run.armReason ?? '', /DecisionProvider|Jev/);
  }
});

// ------------------------------------------------------ fake provider arm

test('LLM_ONLY with the deterministic fake provider evaluates every case', async () => {
  const run = await runEvaluation({ dataset, arm: 'LLM_ONLY', llm: new DeterministicFakeLlmProvider() });
  assert.equal(run.armStatus, 'EXECUTED');
  assert.equal(run.versions.provider, 'fake:deterministic');
  assert.equal(run.versions.model, 'fake-1');
  assert.equal(run.versions.promptVersion, 'fake-deterministic-v1');
  assert.equal(run.metrics.totalCases, dataset.cases.length);
  assert.ok(run.metrics.overall.accuracy > 0.5, `accuracy ${run.metrics.overall.accuracy}`);
  assert.ok(run.metrics.calibration.answered > 0);
  // The fake provider never emits sub-specialties — honest abstention shows up.
  assert.ok(run.metrics.byDimension.subSpecialty.abstentions > 0);
  // Error taxonomy is populated with SPECIFIC categories, not a generic AI error.
  const counted = Object.values(run.metrics.errors.counts).reduce((s, v) => s + v, 0);
  assert.equal(counted, run.metrics.errors.total);
  assert.ok(counted > 0);
});

// --------------------------------------------------- mocked HTTP provider

const MOCK_PROFILE = {
  businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['e0'], availability: 'AVAILABLE' },
  industry: { value: 'Printing', confidence: 0.85, evidenceIds: ['e0'], availability: 'AVAILABLE' },
  specialties: [{ value: 'Printer Parts', confidence: 0.8, evidenceIds: ['e0'], availability: 'AVAILABLE' }],
  city: { value: 'Tehran', confidence: 0.85, evidenceIds: ['e20'], availability: 'AVAILABLE', provenance: 'EXPLICIT' },
};

test('mocked HTTP provider is evaluated through the same framework (no network)', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    // Cite a REAL sample id from the request — the evidence-first validator
    // rejects claims that reference unknown evidence ids.
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[]; response_format?: unknown };
    const userMsg = body.messages?.find((m) => m.content?.includes('evidenceSamples'))?.content ?? '';
    const sampleMatch = /"id":\s*"([^"]+)"/.exec(userMsg);
    const evidenceId = sampleMatch?.[1] ?? 'unknown';
    const profile = {
      businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: [evidenceId], availability: 'AVAILABLE' },
      industry: { value: 'Printing', confidence: 0.85, evidenceIds: [evidenceId], availability: 'AVAILABLE' },
      specialties: [{ value: 'Printer Parts', confidence: 0.8, evidenceIds: [evidenceId], availability: 'AVAILABLE' }],
      city: { value: 'Tehran', confidence: 0.85, evidenceIds: [evidenceId], availability: 'AVAILABLE', provenance: 'EXPLICIT' },
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(profile) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const llm = makeHttpProvider(fetchImpl);
  // Restrict to the canonical HP case via a one-case dataset view.
  const single = { ...dataset, cases: dataset.cases.filter((c) => c.caseId === 'ev-001') };
  const { record, results } = await runEvaluationDetailed({ dataset: single, arm: 'LLM_ONLY', llm });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /llm\.example\.com/);
  assert.equal(record.armStatus, 'EXECUTED');
  assert.equal(record.versions.provider, 'http:mock');
  assert.equal(record.versions.model, 'mock-1');
  assert.equal(record.versions.promptVersion, 'mock-p1');
  const r = results[0] as EvalCaseResult;
  assert.equal(r.outcomes.find((o) => o.dimension === 'businessType')?.actual[0], 'Wholesaler');
  assert.equal(r.outcomes.find((o) => o.dimension === 'location')?.actual[0], 'Tehran');
});

// ------------------------------------------------------------- Jev arms

test('Jev arms execute when a DecisionProvider is injected', async () => {
  const decision = stubDecisionProvider();
  for (const arm of ['LLM_THEN_DECISION_PROVIDER', 'RULES_LLM_DECISION_PROVIDER'] as const) {
    const run = await runEvaluation({ dataset, arm, llm: new DeterministicFakeLlmProvider(), decision });
    assert.equal(run.armStatus, 'EXECUTED', `${arm}: ${run.armReason}`);
    assert.equal(run.metrics.totalCases, dataset.cases.length);
    assert.ok(run.metrics.overall.support > 0);
  }
});

// ---------------------------------------------------- deterministic runs

test('evaluation is deterministic: same inputs → same run id, same case results', async () => {
  const a = await runEvaluationDetailed({ dataset, arm: 'RULES_THEN_LLM', llm: new DeterministicFakeLlmProvider() });
  const b = await runEvaluationDetailed({ dataset, arm: 'RULES_THEN_LLM', llm: new DeterministicFakeLlmProvider() });
  assert.equal(a.record.runId, b.record.runId);
  assert.deepEqual(
    a.results.map((r) => [r.caseId, r.exactMatch, r.dimensionAccuracy, r.scores.priority, r.errorCategory]),
    b.results.map((r) => [r.caseId, r.exactMatch, r.dimensionAccuracy, r.scores.priority, r.errorCategory]),
  );
  // Latency is wall-clock and NOT part of the deterministic contract.
  assert.equal(typeof a.results[0]?.latencyMs, 'number');
});

test('version tracking: changing the policy version changes the run id', async () => {
  const policy = { policyId: 'p2', versionId: 'v2', version: 2, weights: { relevance: 0.4, audienceQuality: 0.2, activity: 0.25, confidence: 0.15 }, thresholds: { qualifiedMin: 80, reviewMin: 60, rejectMax: 40 } };
  const base = await runEvaluation({ dataset, arm: 'RULES_ONLY', llm: null });
  const alt = await runEvaluation({ dataset, arm: 'RULES_ONLY', llm: null, policy });
  assert.notEqual(base.runId, alt.runId);
  assert.equal(base.versions.scoringPolicyVersion, 'bootstrap-v1');
  assert.equal(alt.versions.scoringPolicyVersion, 'bootstrap-v2');
});

// -------------------------------------------- score + calibration sanity

test('run metrics include calibration, score evaluation and separation on the real dataset', async () => {
  const run = await runEvaluation({ dataset, arm: 'RULES_THEN_LLM', llm: new DeterministicFakeLlmProvider() });
  const m = run.metrics;
  assert.ok(m.calibration.buckets.length === 5);
  assert.ok(m.calibration.answered > 100);
  // Human-QUALIFIED leads score higher than human-REJECTED ones (bootstrap policy).
  assert.equal(m.scoreEvaluation.separation.separates, true);
  assert.ok((m.scoreEvaluation.separation.gap ?? 0) > 10);
  // Five score dimensions are all diagnosed.
  assert.equal(m.scoreEvaluation.dimensions.length, 5);
  for (const d of m.scoreEvaluation.dimensions) {
    assert.ok(d.min >= 0 && d.max <= 100);
  }
  // Per-tag metrics exist for the dataset tags.
  assert.ok(m.byTag['CANONICAL'] !== undefined);
  assert.ok(m.byTag['ARABIC_VARIANTS'] !== undefined);
  // Cost is honestly null (no provider usage metadata in this phase).
  assert.equal(m.cost.costPerCase, null);
  assert.equal(m.cost.casesWithCost, 0);
});

test('failed provider marks the arm FAILED instead of returning fake results', async () => {
  const failing: FetchLike = async () => new Response('boom', { status: 500 });
  const llm = makeHttpProvider(failing);
  const run = await runEvaluation({ dataset, arm: 'LLM_ONLY', llm });
  assert.equal(run.armStatus, 'FAILED');
  assert.ok((run.armReason ?? '').length > 0);
});
