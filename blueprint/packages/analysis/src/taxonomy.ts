import type { ClassificationType } from '@ulip/domain/contracts';
import { aliasKey } from '@ulip/domain';
import type { TaxonomyCatalog } from './contracts.ts';

export type MatchVia = 'ID' | 'LABEL' | 'ALIAS' | 'NONE';

export interface TaxonomyMatch {
  taxonomyNodeId: string | null;
  valueText: string | null;
  classificationType: ClassificationType;
  matchedVia: MatchVia;
}

function kindFor(requested: 'BUSINESS_TYPE' | 'INDUSTRY' | 'SPECIALTY'):
  (k: string) => boolean {
  if (requested === 'BUSINESS_TYPE') return (k) => k === 'BUSINESS_TYPE';
  if (requested === 'INDUSTRY') return (k) => k === 'INDUSTRY';
  return (k) => k === 'SPECIALTY' || k === 'SUB_SPECIALTY';
}

function classificationTypeOf(kind: string): ClassificationType {
  if (kind === 'SUB_SPECIALTY') return 'SUB_SPECIALTY';
  if (kind === 'SPECIALTY') return 'SPECIALTY';
  if (kind === 'INDUSTRY') return 'INDUSTRY';
  return 'BUSINESS_TYPE';
}

/**
 * Maps a predicted value onto an EXISTING taxonomy entity when one matches
 * (id → label → alias/slug). When no compatible node exists the value stays
 * free text — we never invent taxonomy strings for kinds that have a node
 * (ADR-011/019). A node of a different kind is NOT reused (no mis-typing).
 */
export function mapToTaxonomy(
  catalog: TaxonomyCatalog,
  requested: 'BUSINESS_TYPE' | 'INDUSTRY' | 'SPECIALTY',
  value: string,
): TaxonomyMatch {
  const accepts = kindFor(requested);
  const trimmed = value.trim();
  const key = aliasKey(trimmed);

  const byId = catalog.nodes.find((n) => n.nodeId === trimmed && accepts(n.nodeKind));
  if (byId !== undefined) {
    return {
      taxonomyNodeId: byId.nodeId,
      valueText: null,
      classificationType: classificationTypeOf(byId.nodeKind),
      matchedVia: 'ID',
    };
  }

  const byLabel = catalog.nodes.find((n) => accepts(n.nodeKind) && aliasKey(n.label) === key);
  if (byLabel !== undefined) {
    return {
      taxonomyNodeId: byLabel.nodeId,
      valueText: null,
      classificationType: classificationTypeOf(byLabel.nodeKind),
      matchedVia: 'LABEL',
    };
  }

  const byAlias = catalog.aliases.find((a) => a.aliasNorm === key);
  if (byAlias !== undefined) {
    const node = catalog.nodes.find((n) => n.nodeId === byAlias.nodeId);
    if (node !== undefined && accepts(node.nodeKind)) {
      return {
        taxonomyNodeId: node.nodeId,
        valueText: null,
        classificationType: classificationTypeOf(node.nodeKind),
        matchedVia: 'ALIAS',
      };
    }
  }

  return {
    taxonomyNodeId: null,
    valueText: trimmed,
    classificationType: classificationTypeOf(requested),
    matchedVia: 'NONE',
  };
}
