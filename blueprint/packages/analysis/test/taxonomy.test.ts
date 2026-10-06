import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapToTaxonomy } from '../src/taxonomy.ts';
import type { TaxonomyCatalog } from '../src/contracts.ts';

const CATALOG: TaxonomyCatalog = {
  nodes: [
    { nodeId: 'n-bt-ws', label: 'Wholesaler', nodeKind: 'BUSINESS_TYPE' },
    { nodeId: 'n-bt-sp', label: 'Service Provider', nodeKind: 'BUSINESS_TYPE' },
    { nodeId: 'n-ind-print', label: 'Printing', nodeKind: 'INDUSTRY' },
    { nodeId: 'n-spec-pp', label: 'Printer Parts', nodeKind: 'SPECIALTY' },
    { nodeId: 'n-sub-pp', label: 'Toner Cartridges', nodeKind: 'SUB_SPECIALTY' },
  ],
  aliases: [
    { nodeId: 'n-bt-ws', aliasNorm: 'wholesale' },
    { nodeId: 'n-spec-pp', aliasNorm: 'قطعات پرینتر' },
    { nodeId: 'n-ind-print', aliasNorm: 'printing supplies' },
  ],
  version: 4,
};

test('maps a value onto an existing node via id, label and alias', () => {
  assert.deepEqual(mapToTaxonomy(CATALOG, 'BUSINESS_TYPE', 'n-bt-ws'), {
    taxonomyNodeId: 'n-bt-ws', valueText: null, classificationType: 'BUSINESS_TYPE', matchedVia: 'ID',
  });
  assert.equal(mapToTaxonomy(CATALOG, 'BUSINESS_TYPE', 'wholesaler').taxonomyNodeId, 'n-bt-ws');
  assert.equal(mapToTaxonomy(CATALOG, 'BUSINESS_TYPE', 'WHOLESALE').matchedVia, 'ALIAS');
  assert.equal(mapToTaxonomy(CATALOG, 'SPECIALTY', 'قطعات پرینتر').taxonomyNodeId, 'n-spec-pp');
  assert.equal(mapToTaxonomy(CATALOG, 'INDUSTRY', 'printing supplies').taxonomyNodeId, 'n-ind-print');
});

test('a node of a different kind is never reused', () => {
  const match = mapToTaxonomy(CATALOG, 'BUSINESS_TYPE', 'Printing');
  assert.equal(match.taxonomyNodeId, null);
  assert.equal(match.valueText, 'Printing');
  assert.equal(match.matchedVia, 'NONE');
});

test('sub-specialty requests accept both SPECIALTY and SUB_SPECIALTY nodes', () => {
  assert.equal(mapToTaxonomy(CATALOG, 'SPECIALTY', 'Toner Cartridges').classificationType, 'SUB_SPECIALTY');
  assert.equal(mapToTaxonomy(CATALOG, 'SPECIALTY', 'Printer Parts').classificationType, 'SPECIALTY');
});

test('values without a taxonomy entity stay free text (no invented nodes)', () => {
  const match = mapToTaxonomy(CATALOG, 'INDUSTRY', 'Quantum Basket Weaving');
  assert.equal(match.taxonomyNodeId, null);
  assert.equal(match.valueText, 'Quantum Basket Weaving');
  assert.equal(match.classificationType, 'INDUSTRY');
});

test('Persian text normalizes before matching aliases', () => {
  const match = mapToTaxonomy(CATALOG, 'SPECIALTY', 'قطعات‌پرینتر'); // ZWNJ variant
  assert.equal(match.taxonomyNodeId, 'n-spec-pp');
});
