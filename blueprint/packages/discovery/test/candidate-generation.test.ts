/**
 * Phase 21 unit tests — pure candidate generation + constraint classification.
 * Deterministic: no DB, no network, no LLM.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  hashtagsFromTaxonomy,
  selectHashtags,
  classifyConstraint,
  extractNumericThreshold,
} from '../src/candidate-generation.ts';
import { normalizeHashtag } from '../src/hashtag-budget.ts';

test('hashtagsFromTaxonomy: dedupes surfaces, ranks deterministically, bounds output', () => {
  const c = hashtagsFromTaxonomy(
    { name: 'وکیل خانواده', slug: 'family-lawyer', aliases: ['وکیل دادگستری', 'family-lawyer', 'وکیل خانواده'] },
    5,
  );
  // slug + name + unique alias (duplicate slug alias removed)
  assert.equal(c.length, 3);
  assert.equal(c[0]?.hashtag, 'family-lawyer');
  assert.equal(c[0]?.rank, 1);
  assert.equal(c[1]?.via, 'name');
  assert.ok(c[2]?.via.startsWith('alias:'));
  // Deterministic: same input → same output
  const again = hashtagsFromTaxonomy({ name: 'وکیل خانواده', slug: 'family-lawyer', aliases: ['وکیل دادگستری', 'family-lawyer', 'وکیل خانواده'] }, 5);
  assert.deepEqual(c, again);
});

test('hashtagsFromTaxonomy: ZWNJ variants collapse via hashtag normalization', () => {
  const c = hashtagsFromTaxonomy({ name: 'وکیل\u200cخانواده', slug: 'family-lawyer', aliases: ['وکیل خانواده'] }, 5);
  const tags = c.map((x) => x.hashtag);
  assert.equal(new Set(tags).size, tags.length, 'no duplicate tags after normalization');
  assert.equal(tags.includes(normalizeHashtag('وکیل خانواده')), true);
});

test('selectHashtags: bounded top-N with honest skipped list', () => {
  const c = hashtagsFromTaxonomy({ name: 'وکیل', slug: 'lawyer', aliases: ['a1', 'a2', 'a3', 'a4', 'a5'] }, 10);
  const { selected, skipped } = selectHashtags(c, 3);
  assert.equal(selected.length, 3);
  assert.equal(skipped.length, c.length - 3);
  assert.equal(selected.every((s, i, arr) => i === 0 || (arr[i - 1]?.rank ?? 0) < s.rank), true);
});

test('classifyConstraint: followers threshold → exact POST_FETCH_FILTER', () => {
  const c = classifyConstraint('حداقل ۵۰۰۰ فالوئر دارند');
  assert.equal(c.kind, 'POST_FETCH_FILTER');
  assert.equal(c.exactness, 'exact');
  const t = extractNumericThreshold('5000 followers at least');
  assert.equal(t?.value, 5000);
  assert.equal(t?.field, 'followers');
});

test('classifyConstraint: activity → POST_FETCH_HEURISTIC (never exact)', () => {
  const c = classifyConstraint('که فعال هستند');
  assert.equal(c.kind, 'POST_FETCH_HEURISTIC');
  assert.equal(c.exactness, 'heuristic');
  assert.match(c.note, /heuristic/);
});

test('classifyConstraint: city → AI_ANALYSIS (evidence-based)', () => {
  const c = classifyConstraint('در تهران');
  assert.equal(c.kind, 'AI_ANALYSIS');
  assert.equal(c.exactness, 'evidence-based');
  assert.match(c.note, /no address fields/);
});

test('classifyConstraint: profession → AI_ANALYSIS (evidence-based)', () => {
  const c = classifyConstraint('وکیل خانواده');
  assert.equal(c.kind, 'AI_ANALYSIS');
  assert.equal(c.exactness, 'evidence-based');
});

test('classifyConstraint: unprovable constraint stays visible, never silently dropped', () => {
  const c = classifyConstraint('خوش‌نام و معروف باشد');
  assert.equal(c.kind, 'UNPROVABLE');
  assert.equal(c.exactness, 'unprovable');
  assert.match(c.note, /never applied/);
});
