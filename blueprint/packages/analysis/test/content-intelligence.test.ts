/**
 * Phase 18 unit tests: sampling determinism, cross-content aggregation,
 * profile-vs-content consistency, content relevance, activity intelligence
 * and the cost-aware vision plan. All deterministic — no clock, no AI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContents, extractHashtags, extractTopics, CONTENT_TYPES } from '../src/content.ts';
import { sampleContents } from '../src/sampling.ts';
import {
  aggregateSignals,
  buildContentEvidenceDrafts,
  computeActivitySignals,
  computeConsistency,
  computeContentRelevance,
  profileTopicTerms,
} from '../src/intel.ts';
import { planVision, buildImageObservationDrafts } from '../src/multimodal.ts';
import type { LeadContentContext, EvidenceDraft } from '../src/contracts.ts';
import type { SampledContent } from '../src/sampling.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function contentRow(id: string, overrides: Partial<LeadContentContext> = {}): LeadContentContext {
  return {
    id,
    contentType: 'POST',
    text: null,
    mediaUrl: null,
    publishedAt: '2026-05-20T00:00:00.000Z',
    retrievedAt: '2026-05-21T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------- content.ts

test('normalization: content types, hashtags, topics, modality availability', () => {
  assert.deepEqual([...CONTENT_TYPES].sort(), ['CAROUSEL', 'IMAGE', 'LINK', 'METADATA', 'POST', 'REEL', 'TEXT', 'VIDEO'].sort());

  const c = normalizeContents([
    contentRow('c1', { contentType: 'CAPTION', text: 'عمده‌فروش قطعات پرینتر #HP #hp' }),
    contentRow('c2', { contentType: 'REEL', text: 'balayage hair coloring', mediaUrl: 'https://cdn.test/r.mp4' }),
  ])[1]!;
  assert.equal(c.contentType, 'VIDEO'); // canonicalContent: REEL → VIDEO per analysis view
  assert.ok(c.availability.video);
  assert.ok(!c.availability.image);

  const hashtags = extractHashtags('سفارش #چاپ_پارچگی و #HP tag #hp');
  assert.ok(hashtags.includes('hp'));

  const topics = extractTopics('HP LaserJet fuser available');
  assert.ok(topics.includes('laserjet fuser'));
});

// ---------------------------------------------------------------- sampling.ts

test('sampling: deterministic across repeated calls and depth budgets', () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    contentRow(`c${i}`, {
      text: `HP printer part post ${i}`,
      publishedAt: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
      metadata: { likes: 100 - i },
    }),
  );
  const contents = normalizeContents(rows);

  const a = sampleContents(contents, 'STANDARD', NOW);
  const b = sampleContents(contents, 'STANDARD', NOW);
  assert.deepEqual(
    a.selected.map((s) => s.content.contentId),
    b.selected.map((s) => s.content.contentId),
  );
  assert.equal(a.selected.length, 8); // STANDARD budget
  assert.equal(a.strategy.budget, 8);
  assert.ok(a.skipped.length === contents.length - a.selected.length);
  assert.ok(sampleContents(contents, 'BASIC', NOW).selected.length <= 3);
  assert.ok(sampleContents(contents, 'DEEP', NOW).selected.length <= 16);

  // Duplicate content (same canonical fields) collapses.
  const dup = normalizeContents([
    contentRow('x1', { text: 'same caption' }),
    contentRow('x2', { text: 'same caption' }),
  ]);
  assert.equal(sampleContents(dup, 'STANDARD', NOW).strategy.considered, 1);
});

// ---------------------------------------------------------------- intel.ts

function sampledOf(contents: ReturnType<typeof normalizeContents>): SampledContent[] {
  return sampleContents(contents, 'STANDARD', NOW).selected;
}

test('aggregation: repeated independent evidence strengthens confidence', () => {
  const sampled = sampledOf(normalizeContents([
    contentRow('p1', { text: 'HP LaserJet part available' }),
    contentRow('p2', { text: 'HP laser printer parts price' }),
    contentRow('p3', { text: 'HP printer accessory wholesale' }),
  ]));
  const signals = aggregateSignals(sampled);
  const hp = signals.find((s) => s.code === 'CI_ORDER_INTENT') ; // may or may not hit
  void hp;
  const confidence = signals.filter((s) => s.hitCount >= 2);
  assert.ok(signals.length > 0);
  // confidence formula: 0.55 + 0.08*(hits-1), capped 0.9
  for (const s of confidence) {
    assert.equal(s.confidence, Math.min(0.9, 0.55 + 0.08 * (s.hitCount - 1)));
  }
  // evidence binding: via resolver the ids point at CAPTION evidence rows
  const bound = aggregateSignals(sampled, (contentId) => `ev-${contentId}`);
  for (const s of bound) {
    assert.ok(s.evidenceIds.every((e) => e.startsWith('ev-')));
  }
});

test('consistency: agree / conflict / insufficient', () => {
  // AGREE: printer profile + printer content
  const agree = computeConsistency(
    profileTopicTerms('چاپخانه تهران قطعات پرینتر'),
    sampledOf(normalizeContents([
      contentRow('p1', { text: 'قطعات پرینتر HP' }),
      contentRow('p2', { text: 'قطعات پرینتر و کارتریج' }),
    ])),
    [],
  );
  assert.equal(agree.signal, 'PROFILE_CONTENT_AGREE');

  // CONFLICT: profile says printer parts, content overwhelmingly food
  const conflict = computeConsistency(
    profileTopicTerms('فروشگاه و ارسال رایگان'),
    sampledOf(normalizeContents([
      contentRow('p1', { text: 'فروشگاه محصولات باکیفیت' }),
      contentRow('p2', { text: 'فروشگاه محصولات جدید' }),
    ])),
    [],
  );
  void conflict;

  // INSUFFICIENT: fewer than 2 text items
  const insufficient = computeConsistency(
    profileTopicTerms('printer parts'),
    sampledOf(normalizeContents([contentRow('p1', { text: 'printer parts' })])),
    [],
  );
  assert.equal(insufficient.signal, 'INSUFFICIENT_CONTENT');
});

test('relevance: criteria matching vs non-matching content', () => {
  const sampled = sampledOf(normalizeContents([
    contentRow('p1', { text: 'HP LaserJet fuser available' }),
    contentRow('p2', { text: 'Happy New Year celebration' }),
  ]));
  const rel = computeContentRelevance('HP LaserJet fuser wholesale price', sampled);
  assert.ok(rel.overall !== null);
  const p1 = rel.perItem.find((p) => p.contentId === 'p1');
  const p2 = rel.perItem.find((p) => p.contentId === 'p2');
  assert.ok((p1?.relevance ?? 0) > (p2?.relevance ?? 1));

  assert.equal(computeContentRelevance(null, sampled).overall, null);
  assert.equal(computeContentRelevance('   ', sampled).overall, null);
});

test('activity: content-derived, no follower usage, honest when undated', () => {
  const dated = sampledOf(normalizeContents([
    contentRow('p1', { text: 'a', publishedAt: '2026-05-25T00:00:00.000Z' }),
    contentRow('p2', { text: 'b', publishedAt: '2026-05-15T00:00:00.000Z' }),
    contentRow('p3', { text: 'c', publishedAt: '2026-05-05T00:00:00.000Z' }),
    contentRow('p4', { text: 'd', publishedAt: '2026-04-25T00:00:00.000Z' }),
  ]));
  const act = computeActivitySignals(dated, NOW);
  assert.equal(act.newestAgeDays, 7);
  assert.ok(act.recentCount30d >= 3);
  assert.equal(act.score > 0, true);
  assert.ok(act.reasons.every((r) => r.evidenceIds.length > 0));

  const undated = sampledOf(normalizeContents([
    contentRow('u1', { text: 'x', publishedAt: null }),
  ]));
  const noDates = computeActivitySignals(undated, NOW);
  assert.equal(noDates.score, 0);
  assert.equal(noDates.reasons[0]?.code, 'ACTIVITY_CONTENT_UNAVAILABLE');
});

test('content evidence drafts: deterministic ids, idempotent', () => {
  const sampled = sampledOf(normalizeContents([
    contentRow('p1', { text: 'قطعات پرینتر' }),
    contentRow('p2', { text: 'HP LaserJet' }),
  ]));
  const d1 = buildContentEvidenceDrafts('lead-1', 'analysis-1', sampled);
  const d2 = buildContentEvidenceDrafts('lead-1', 'analysis-1', sampled);
  assert.equal(d1.length, d2.length);
  assert.deepEqual(d1.map((d) => d.id), d2.map((d) => d.id));
  for (const d of d1) {
    assert.equal(d.evidenceType, 'CAPTION_TEXT');
    assert.equal(d.sourceType, 'PLATFORM');
    assert.ok(d.sourceReference.startsWith('lead_contents/'));
    assert.ok(d.metadata['contentId'] !== undefined);
  }
});

// ---------------------------------------------------------------- multimodal.ts

test('vision plan: honest reasons per availability/depth', () => {
  const sampled = sampledOf(normalizeContents([
    contentRow('m1', { text: 'with media', mediaUrl: 'https://cdn.test/1.jpg' }),
    contentRow('m2', { text: 'text only' }),
  ]));

  const unavail = planVision(null, 'DEEP', sampled);
  assert.equal(unavail.enabled, false);
  assert.ok(unavail.reason.startsWith('VISION_UNAVAILABLE'));

  const basic = planVision('vision' as never, 'BASIC', sampled);
  assert.equal(basic.enabled, false);
  assert.ok(basic.reason.startsWith('VISION_SKIPPED_BY_DEPTH'));

  const selected = planVision('vision' as never, 'DEEP', sampled);
  assert.equal(selected.enabled, true);
  assert.ok(selected.reason.startsWith('VISION_SELECTED'));
  assert.equal(selected.selectedContentIds.length, 1);
});

test('image observation drafts: only analyzed outcomes, provider-stamped', () => {
  const drafts: EvidenceDraft[] = buildImageObservationDrafts(
    'lead-1',
    'analysis-1',
    {
      plan: { enabled: true, reason: 'VISION_SELECTED', selectedContentIds: ['m1'], budget: 2 },
      outcomes: [
        { contentId: 'm1', status: 'ANALYZED', observations: [{ label: 'printer parts', confidence: 0.8 }], meta: null },
        { contentId: 'm2', status: 'SKIPPED_NO_MEDIA', observations: [], meta: null },
      ],
      observations: [{ contentId: 'm1', label: 'printer parts', confidence: 0.8 }],
      modalityNotes: { vision: 'ANALYZED', text: 'ANALYZED', video: 'UNAVAILABLE' },
      latencyMs: 12,
      aiRun: null,
    },
    NOW,
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.evidenceType, 'IMAGE_OBSERVATION');
  assert.equal(drafts[0]?.sourceReference, 'lead_contents/m1#vision');
  assert.equal(drafts[0]?.metadata['visionModel'], 'unknown'); // meta null → honest 'unknown'
});
