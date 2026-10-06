/**
 * Phase 18 content ingestion unit tests: payload → ExtractedContent parsing,
 * canonical content types, deterministic ids and the ingestor contract shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractContentItems,
  canonicalContentType,
  deterministicUuid,
  sha256Hex,
  type ExtractedContent,
} from '../src/content.ts';

test('canonicalContentType: Instagram-style words map onto the widened CHECK set', () => {
  assert.equal(canonicalContentType('IMAGE'), 'IMAGE');
  assert.equal(canonicalContentType('REELS'), 'REEL');
  assert.equal(canonicalContentType('CAROUSEL_ALBUM'), 'CAROUSEL');
  assert.equal(canonicalContentType('VIDEO'), 'VIDEO');
  assert.equal(canonicalContentType('CAPTION'), 'TEXT');
  assert.equal(canonicalContentType('TEXT'), 'TEXT');
  assert.equal(canonicalContentType('POST'), 'POST');
  assert.equal(canonicalContentType('stuff'), 'POST');
  assert.equal(canonicalContentType(undefined), 'POST');
});

test('extractContentItems: posts arrays, media arrays, bare caption strings', () => {
  const payload = {
    biography: 'عمده‌فروش قطعات پرینتر',
    posts: [
      { id: 'ig-179', text: 'قطعات پرینتر HP', timestamp: '2026-05-01T10:00:00Z', likes: 42, media_type: 'IMAGE', media_url: 'https://cdn.test/1.jpg' },
      'bare caption string',
      { id: 'ig-180', caption: 'عمده قیمت گذاری شد', media_product_type: 'REELS', thumbnail_url: 'https://cdn.test/2.jpg' },
    ],
    media: [{ id: 'm-1', permalink: 'https://instagram.test/p/1' }],
  };
  const items = extractContentItems(payload);
  assert.equal(items.length, 4);

  const first: ExtractedContent = items[0]!;
  assert.equal(first.sourceContentId, 'ig-179');
  assert.equal(first.contentType, 'IMAGE');
  assert.equal(first.mediaUrl, 'https://cdn.test/1.jpg');
  assert.equal(first.publishedAt, '2026-05-01T10:00:00.000Z');
  assert.equal(first.metadata['likes'], 42);

  assert.equal(items[1]!.contentType, 'TEXT');
  assert.equal(items[1]!.text, 'bare caption string');

  const reel = items[2]!;
  assert.equal(reel.contentType, 'REEL');
  assert.equal(reel.mediaUrl, 'https://cdn.test/2.jpg');
  assert.equal(reel.text, 'عمده قیمت گذاری شد');

  assert.equal(items[3]!.sourceContentId, 'm-1');
  assert.equal(items[3]!.metadata['permalink'], 'https://instagram.test/p/1');
});

test('extractContentItems: deterministic, dedupes ids, caps the flood', () => {
  const payload = { posts: Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, text: `post ${i}` })) };
  const a = extractContentItems(payload);
  const b = extractContentItems(payload);
  assert.deepEqual(a.map((i) => ({ id: i.sourceContentId, h: i.contentHash })), b.map((i) => ({ id: i.sourceContentId, h: i.contentHash })));
  assert.equal(a.length, 100); // MAX_CONTENT_ITEMS_PER_PAYLOAD

  const duped = extractContentItems({ posts: [{ id: 'x', text: 't' }, { id: 'x', text: 't' }] });
  assert.equal(duped.length, 1);
});

test('deterministic ids: same inputs → same uuid, stable hash', () => {
  assert.equal(deterministicUuid('lead-content', 'lead-1', 'post-1', 'hash'), deterministicUuid('lead-content', 'lead-1', 'post-1', 'hash'));
  assert.notEqual(deterministicUuid('lead-content', 'lead-1', 'post-1', 'hash'), deterministicUuid('lead-content', 'lead-1', 'post-2', 'hash'));
  assert.equal(sha256Hex('a'), sha256Hex('a'));
  // v5-shaped: version + variant bits set
  const u = deterministicUuid('ns', 'a');
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('content hash: canonical fields only (caption change → new version row)', () => {
  const [one] = extractContentItems({ posts: [{ id: 'p1', text: 'same text', media_url: 'https://m' }] });
  const [two] = extractContentItems({ posts: [{ id: 'p1', text: 'changed text', media_url: 'https://m' }] });
  assert.notEqual(one!.contentHash, two!.contentHash);
});
