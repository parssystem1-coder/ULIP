import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DeterministicFakeLlmProvider, validateExtractionOutput, type ProfileExtractionInput } from '../src/index.ts';

const SNAPSHOT = [
  { nodeId: '10000000-0000-0000-0000-000000000001', label: 'Wholesaler', nodeKind: 'BUSINESS_TYPE' as const },
  { nodeId: '10000000-0000-0000-0000-000000000002', label: 'Service Provider', nodeKind: 'BUSINESS_TYPE' as const },
  { nodeId: '20000000-0000-0000-0000-000000000001', label: 'Printing', nodeKind: 'INDUSTRY' as const },
  { nodeId: '20000000-0000-0000-0000-000000000002', label: 'Beauty', nodeKind: 'INDUSTRY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000001', label: 'Printer Parts', nodeKind: 'SPECIALTY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000002', label: 'Hair Coloring', nodeKind: 'SPECIALTY' as const },
  { nodeId: '30000000-0000-0000-0000-000000000003', label: 'Balayage', nodeKind: 'SPECIALTY' as const },
];

function input(text: string, id = 'ev-1'): ProfileExtractionInput {
  return {
    profileText: text,
    locationHints: [],
    contentSamples: [{ contentId: id, text }],
    taxonomySnapshot: SNAPSHOT,
    locale: 'en',
  };
}

test('HP printer parts wholesaler Tehran → universal business model', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const result = await provider.extractStructuredProfile(
    input('HP printer parts wholesaler Tehran, wholesale printer supplies'),
  );
  const p = result.profile;
  assert.equal(p.businessType?.value, '10000000-0000-0000-0000-000000000001');
  assert.equal(p.industry?.value, '20000000-0000-0000-0000-000000000001');
  assert.equal(p.specialties[0]?.value, '30000000-0000-0000-0000-000000000001');
  assert.equal(p.brands?.[0]?.value, 'HP');
  assert.equal(p.city?.value, 'Tehran');
  assert.equal(p.city?.provenance, 'EXPLICIT');
  assert.equal(result.meta.provider, 'fake:deterministic');
});

test('Shiraz hair salon coloring balayage → service provider / beauty', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const { profile: p } = await provider.extractStructuredProfile(
    input('hair salon coloring balayage in Shiraz'),
  );
  assert.equal(p.businessType?.value, '10000000-0000-0000-0000-000000000002');
  assert.equal(p.industry?.value, '20000000-0000-0000-0000-000000000002');
  const labels = p.specialties.map((s) => s.value).sort();
  assert.deepEqual(labels, [
    '30000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000003',
  ]);
  assert.equal(p.city?.value, 'Shiraz');
});

test('Persian evidence maps to the same canonical labels', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const { profile: p } = await provider.extractStructuredProfile(
    input('عمده‌فروش قطعات پرینتر HP در تهران'),
  );
  assert.equal(p.businessType?.value, '10000000-0000-0000-0000-000000000001');
  assert.equal(p.specialties[0]?.value, '30000000-0000-0000-0000-000000000001');
  assert.equal(p.city?.value, 'Tehran');
});

test('falls back to canonical labels when the taxonomy has no matching node', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const { profile: p } = await provider.extractStructuredProfile({
    ...input('wholesaler of printer parts'),
    taxonomySnapshot: [],
  });
  assert.equal(p.businessType?.value, 'Wholesaler');
  assert.equal(p.industry?.value, 'Printing');
});

test('is deterministic and evidence-first: same input, identical output, cited ids exist', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const req = input('hair salon coloring balayage in Shiraz', 'ev-7');
  const a = await provider.extractStructuredProfile(req);
  const b = await provider.extractStructuredProfile(req);
  assert.deepEqual(a, b);

  const cited = [
    ...(a.profile.businessType?.evidenceIds ?? []),
    ...(a.profile.industry?.evidenceIds ?? []),
    ...a.profile.specialties.flatMap((s) => s.evidenceIds),
    ...(a.profile.city?.evidenceIds ?? []),
  ];
  assert.ok(cited.length > 0);
  for (const id of cited) assert.equal(id, 'ev-7');

  assert.equal(validateExtractionOutput(req, a.profile).ok, true);
});

test('claims nothing when there is no citable evidence sample', async () => {
  const provider = new DeterministicFakeLlmProvider();
  const { profile } = await provider.extractStructuredProfile({
    profileText: 'wholesaler printer parts Tehran',
    locationHints: ['Tehran'],
    contentSamples: [],
    taxonomySnapshot: SNAPSHOT,
    locale: 'en',
  });
  assert.equal(profile.businessType, undefined);
  assert.equal(profile.city, undefined);
  assert.equal(profile.specialties.length, 0);
});
