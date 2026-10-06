import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildEvidenceDrafts, evidenceSamples, profileText } from '../src/evidence.ts';
import { deterministicUuid, sha256Hex } from '../src/ids.ts';
import { LEAD, makeLeadContext } from './fakes.ts';

const ANALYSIS = '99999999-9999-9999-9999-999999999999';
const NOW = new Date('2026-10-06T00:00:00.000Z');

test('deterministic ids and hashes are stable across runs', () => {
  const a = deterministicUuid('evidence', ANALYSIS, 'BIO_TEXT', 'ref', 'hash');
  const b = deterministicUuid('evidence', ANALYSIS, 'BIO_TEXT', 'ref', 'hash');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a, deterministicUuid('evidence', 'other-job', 'BIO_TEXT', 'ref', 'hash'));
  assert.equal(sha256Hex('x'), sha256Hex('x'));
});

test('builds evidence only from observed data, with provenance per item', () => {
  const drafts = buildEvidenceDrafts(LEAD, ANALYSIS, makeLeadContext(), NOW);
  assert.ok(drafts.length >= 4, `expected >=4 drafts, got ${drafts.length}`);

  for (const d of drafts) {
    assert.equal(d.leadId, LEAD);
    assert.ok(d.sourceReference.length > 0, 'provenance is required');
    assert.equal(d.contentHash.length, 64);
    assert.ok(d.confidence > 0 && d.confidence <= 1);
    assert.equal(d.retrievedAt.length > 0, true);
  }

  const bio = drafts.find((d) => d.evidenceType === 'BIO_TEXT');
  assert.ok(bio !== undefined);
  assert.equal(bio.content, 'عمده‌فروش قطعات پرینتر HP');
  assert.equal(bio.sourceReference, 'raw_entities/66666666-6666-6666-6666-666666666666#biography');
  assert.equal(bio.sourceType, 'FAKE');

  const city = drafts.find((d) => d.evidenceType === 'LOCATION_SIGNAL');
  assert.equal(city?.content, 'تهران');
  const category = drafts.find((d) => (d.content ?? '').startsWith('category: '));
  assert.equal(category?.content, 'category: WHOLESALE');
  const engagement = drafts.find((d) => d.evidenceType === 'ENGAGEMENT_SIGNAL');
  assert.ok(engagement !== undefined);
  assert.equal(engagement.metadata['followers'], 1200);
});

test('a second build with the same input produces the same ids (retry-safe)', () => {
  const ctx = makeLeadContext();
  const a = buildEvidenceDrafts(LEAD, ANALYSIS, ctx, NOW);
  const b = buildEvidenceDrafts(LEAD, ANALYSIS, ctx, NOW);
  assert.deepEqual(a.map((d) => d.id), b.map((d) => d.id));
});

test('missing fields simply produce no evidence (never invented)', () => {
  const empty = makeLeadContext({ rawPayloads: [], identities: [], locations: [], contacts: [], contents: [] });
  const drafts = buildEvidenceDrafts(LEAD, ANALYSIS, empty, NOW);
  assert.equal(drafts.some((d) => d.evidenceType === 'BIO_TEXT'), false);
  assert.equal(drafts.some((d) => d.evidenceType === 'LOCATION_SIGNAL'), false);
  // The canonical business name is still observed profile metadata.
  assert.equal(drafts.filter((d) => d.evidenceType === 'PROFILE_METADATA').length >= 1, true);
});

test('contact values are never copied into evidence (PII minimization)', () => {
  const ctx = makeLeadContext({
    contacts: [{ kind: 'PHONE', availability: 'AVAILABLE', isSensitive: true }],
  });
  const drafts = buildEvidenceDrafts(LEAD, ANALYSIS, ctx, NOW);
  const contact = drafts.find((d) => (d.content ?? '').startsWith('contact channel available'));
  assert.ok(contact !== undefined);
  assert.equal((contact.content ?? '').includes('+98'), false);
  assert.equal(contact.metadata['kind'], 'PHONE');
});

test('samples expose the evidence id so every AI claim stays traceable', () => {
  const drafts = buildEvidenceDrafts(LEAD, ANALYSIS, makeLeadContext(), NOW);
  const samples = evidenceSamples(drafts);
  assert.equal(samples.length, drafts.filter((d) => d.content !== null).length);
  for (const s of samples) {
    assert.ok(drafts.some((d) => d.id === s.contentId));
    assert.ok((s.text ?? '').length > 0);
  }
  assert.ok(profileText(drafts).includes('عمده‌فروش'));
});
