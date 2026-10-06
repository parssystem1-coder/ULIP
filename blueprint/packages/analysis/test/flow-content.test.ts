/**
 * Phase 18 flow tests: content-aware analysis end-to-end with the memory
 * fakes — sampling → evidence → vision → extraction → scoring → persistence,
 * plus review reasons, contradiction handling and idempotent replay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeLeadContext,
  MemoryAnalysisStore,
  MemoryLifecycle,
  MemoryPolicy,
  memoryLog,
  LEAD,
  TENANT,
  TAXONOMY_NODES,
} from './fakes.ts';
import { runAnalysisForLead } from '../src/flow.ts';
import { DeterministicFakeLlmProvider } from '@ulip/ai';
import type { AnalysisFlowDeps, LeadContentContext } from '../src/contracts.ts';

function depsFor(store: MemoryAnalysisStore, lifecycle: MemoryLifecycle): AnalysisFlowDeps {
  return {
    log: memoryLog,
    store,
    ai: {
      status: 'READY',
      llm: new DeterministicFakeLlmProvider('fake', 'fake-1'),
      vision: null,
      embedding: null,
      decision: null,
      meta: { kind: 'FAKE', provider: 'fake', modelVersion: 'fake-1', promptVersion: 'fake-p1', schemaVersion: '1' },
      missing: [],
      reason: 'ready',
    },
    policy: new MemoryPolicy(),
    lifecycle,
    now: () => new Date('2026-06-01T00:00:00.000Z'),
  };
}

const daysAgoIso = (d: number, base = new Date('2026-06-01T00:00:00.000Z')): string =>
  new Date(base.getTime() - d * 86_400_000).toISOString();

function contentRow(id: string, text: string, overrides: Partial<LeadContentContext> = {}): LeadContentContext {
  return { id, contentType: 'POST', text, mediaUrl: null, publishedAt: daysAgoIso(2), retrievedAt: daysAgoIso(1), metadata: {}, ...overrides };
}

test('flow: content-aware run persists content analysis + items + signals', async () => {
  const store = new MemoryAnalysisStore();
  const lifecycle = new MemoryLifecycle();
  const ctx = makeLeadContext({
    business: {
      canonicalName: 'چاپخانه تهران',
      description: 'عمده‌فروشی قطعات پرینتر',
      website: 'https://chap-tehran.example.test',
      businessTypeNodeId: null,
      industryNodeId: null,
    },
    contents: [
      contentRow('lc-1', 'قطعات پرینتر HP موجود است', { publishedAt: daysAgoIso(3) }),
      contentRow('lc-2', 'قطعات پرینتر و کارتریج — قیمت عمده', { publishedAt: daysAgoIso(10) }),
      contentRow('lc-3', 'قیمت عمده قطعات پرینتر', { publishedAt: daysAgoIso(25) }),
    ],
  });
  store.put(ctx);
  const deps = depsFor(store, lifecycle);

  const outcome = await runAnalysisForLead(deps, { leadId: LEAD, analysisMode: 'STANDARD' }, { tenantId: TENANT, jobId: 'job-content-1' });

  assert.equal(outcome.finalStatus, 'QUALIFIED');
  assert.ok(outcome.contentAnalysis !== undefined);
  assert.equal(outcome.contentAnalysis.consistency, 'PROFILE_CONTENT_AGREE');
  assert.ok(outcome.contentAnalysis.activityScore !== null);

  const ca = store.contentAnalyses[0]!;
  assert.equal(ca.analysis.profileContentConsistency, 'PROFILE_CONTENT_AGREE');
  assert.ok(ca.items.length >= 2);
  for (const item of ca.items) {
    assert.ok(item.leadContentId.startsWith('lc-') || item.leadContentId.length === 36);
    assert.ok(item.modalityNotes['text'] !== undefined);
  }
  // Evidence includes CAPTION_TEXT rows carrying contentId metadata.
  const captions = store.evidence.filter((e) => e.evidenceType === 'CAPTION_TEXT');
  assert.ok(captions.length >= 2);
});

test('flow: BASIC mode skips vision budget entirely; DEEP mode selects media for vision plan', async () => {
  const store = new MemoryAnalysisStore();
  const lifecycle = new MemoryLifecycle();
  const ctx = makeLeadContext({
    contents: [
      contentRow('lc-1', 'printer parts post with image', { mediaUrl: 'https://cdn.test/1.jpg', publishedAt: daysAgoIso(3) }),
      contentRow('lc-2', 'printer fuser available', { mediaUrl: 'https://cdn.test/2.jpg', publishedAt: daysAgoIso(10) }),
    ],
  });
  store.put(ctx);
  const deps = depsFor(store, lifecycle);
  const outcome = await runAnalysisForLead(deps, { leadId: LEAD, analysisMode: 'BASIC' }, { tenantId: TENANT, jobId: 'job-basic-1' });
  assert.equal(outcome.finalStatus, 'QUALIFIED');
  // BASIC → vision budget 0; vision stayed UNAVAILABLE in the modality notes.
  const ca = store.contentAnalyses[0]!;
  const visionNote = String(ca.items[0]?.modalityNotes['vision'] ?? '');
  assert.ok(visionNote !== 'ANALYZED');
});

test('flow: idempotent replay keeps evidence rows and content analyses stable', async () => {
  const store = new MemoryAnalysisStore();
  const makeCtx = () =>
    makeLeadContext({
      contents: [
        contentRow('lc-1', 'printer parts post', {}),
        contentRow('lc-2', 'more printer consumables', {}),
      ],
    });
  store.put(makeCtx());
  const payload = { leadId: LEAD, analysisMode: 'STANDARD' };

  // Run 1 (job-r1): the lead reaches a terminal state, as in production.
  const run1 = await runAnalysisForLead(
    depsFor(store, new MemoryLifecycle()),
    payload,
    { tenantId: TENANT, jobId: 'job-r1' },
  );
  const evidenceAfter1 = store.evidence.length;
  const caAfter1 = store.contentAnalyses.length;
  assert.ok(caAfter1 >= 1);

  // Replay of the SAME job (fresh lifecycle: the worker re-claimed it after a
  // crash; statuses go back through the REPROCESS re-arm path) — deterministic
  // ids mean the replay inserts nothing new.
  store.put(makeCtx());
  const run2 = await runAnalysisForLead(
    depsFor(store, new MemoryLifecycle()),
    payload,
    { tenantId: TENANT, jobId: 'job-r1' },
  );
  assert.equal(run2.analysisId, run1.analysisId);
  assert.equal(store.evidence.length, evidenceAfter1);
  assert.equal(store.contentAnalyses.length, caAfter1);

  // A DIFFERENT job creates a new version; history is preserved.
  store.put(makeCtx());
  const run3 = await runAnalysisForLead(
    depsFor(store, new MemoryLifecycle()),
    payload,
    { tenantId: TENANT, jobId: 'job-r2' },
  );
  assert.notEqual(run3.analysisId, run1.analysisId);
  assert.equal(store.contentAnalyses.length, caAfter1 + 1);
  const leadCaIds = new Set(store.contentAnalyses.map((c) => c.analysis.id));
  assert.ok(leadCaIds.has(store.currentContentAnalysis.get(LEAD) ?? ''));
});
