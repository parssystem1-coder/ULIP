import type {
  AiMetadata,
  FieldPrediction,
  StructuredProfile,
} from '@ulip/ai';
import type { Availability, ClassificationType } from '@ulip/domain/contracts';
import { aliasKey } from '@ulip/domain';
import type {
  ClassificationDraft,
  ClassificationSummary,
  EvidenceDraft,
  LeadContext,
  TaxonomyCatalog,
} from './contracts.ts';
import { mapToTaxonomy, type TaxonomyMatch } from './taxonomy.ts';

function claimed(p: FieldPrediction | undefined): p is FieldPrediction {
  return p !== undefined && p.availability !== 'UNAVAILABLE' && p.evidenceIds.length > 0;
}

function labelFor(catalog: TaxonomyCatalog, nodeId: string | null, fallback: string): string {
  if (nodeId === null) return fallback;
  return catalog.nodes.find((n) => n.nodeId === nodeId)?.label ?? fallback;
}

export interface MappedClassification {
  draft: ClassificationDraft;
  summary: ClassificationSummary;
}

/**
 * Maps every evidence-backed prediction onto the EXISTING taxonomy entities.
 * Brands stay free text (no BRAND node kind exists); location uses the
 * OTHER classification type exactly like the discovery normalizer does.
 */
export function mapClassifications(
  catalog: TaxonomyCatalog,
  profile: StructuredProfile,
  modelVersion: string,
  source: 'AI' | 'RULE',
): { mapped: MappedClassification[]; cityMatch: TaxonomyMatch | null } {
  const mapped: MappedClassification[] = [];

  const push = (
    requested: 'BUSINESS_TYPE' | 'INDUSTRY' | 'SPECIALTY',
    p: FieldPrediction,
  ): void => {
    const match = mapToTaxonomy(catalog, requested, p.value);
    const draft: ClassificationDraft = {
      classificationType: match.classificationType,
      taxonomyNodeId: match.taxonomyNodeId,
      valueText: match.valueText,
      valueNormalized: aliasKey(match.valueText ?? labelFor(catalog, match.taxonomyNodeId, p.value)),
      confidence: p.confidence,
      source,
      modelVersion,
    };
    mapped.push({
      draft,
      summary: {
        classificationType: match.classificationType,
        value: match.valueText ?? labelFor(catalog, match.taxonomyNodeId, p.value),
        taxonomyNodeId: match.taxonomyNodeId,
        confidence: p.confidence,
        availability: p.availability,
        evidenceIds: p.evidenceIds,
      },
    });
  };

  if (claimed(profile.businessType)) push('BUSINESS_TYPE', profile.businessType);
  if (claimed(profile.industry)) push('INDUSTRY', profile.industry);
  for (const s of profile.specialties) if (claimed(s)) push('SPECIALTY', s);

  for (const b of profile.brands ?? []) {
    if (!claimed(b)) continue;
    mapped.push({
      draft: {
        classificationType: 'BRAND',
        taxonomyNodeId: null,
        valueText: b.value,
        valueNormalized: aliasKey(b.value),
        confidence: b.confidence,
        source,
        modelVersion,
      },
      summary: {
        classificationType: 'BRAND',
        value: b.value,
        taxonomyNodeId: null,
        confidence: b.confidence,
        availability: b.availability,
        evidenceIds: b.evidenceIds,
      },
    });
  }

  let cityMatch: TaxonomyMatch | null = null; // cities never map to a taxonomy kind
  if (claimed(profile.city)) {
    mapped.push({
      draft: {
        classificationType: 'OTHER',
        taxonomyNodeId: null,
        valueText: profile.city.value,
        valueNormalized: aliasKey(profile.city.value),
        confidence: profile.city.confidence,
        source,
        modelVersion,
      },
      summary: {
        classificationType: 'OTHER',
        value: profile.city.value,
        taxonomyNodeId: null,
        confidence: profile.city.confidence,
        availability: profile.city.availability,
        evidenceIds: profile.city.evidenceIds,
      },
    });
  }
  return { mapped, cityMatch };
}

/** The persisted universal business model (readable via GET .../analysis). */
export function buildUniversalModel(
  profile: StructuredProfile,
  catalog: TaxonomyCatalog,
  mapped: readonly MappedClassification[],
): Record<string, unknown> {
  const entry = (summary: ClassificationSummary | undefined, p: FieldPrediction | undefined) =>
    summary === undefined || p === undefined
      ? { available: false as const, reason: 'not detected' }
      : {
          available: p.availability !== 'UNAVAILABLE',
          value: summary.value,
          taxonomyNodeId: summary.taxonomyNodeId,
          classificationType: summary.classificationType,
          confidence: summary.confidence,
          availability: p.availability,
          evidenceIds: p.evidenceIds,
        };

  const byType = (t: ClassificationType): ClassificationSummary | undefined =>
    mapped.find((m) => m.summary.classificationType === t)?.summary;

  return {
    businessType: entry(byType('BUSINESS_TYPE'), profile.businessType),
    industry: entry(byType('INDUSTRY'), profile.industry),
    specialties: profile.specialties.map((s, i) => entry(byType('SPECIALTY') ?? mapped[i]?.summary, s)),
    brands: (profile.brands ?? []).map((b) => entry(byType('BRAND'), b)),
    city:
      profile.city === undefined
        ? { available: false as const, reason: 'not detected' }
        : {
            available: profile.city.availability !== 'UNAVAILABLE',
            value: profile.city.value,
            provenance: profile.city.provenance,
            confidence: profile.city.confidence,
            availability: profile.city.availability as Availability,
            evidenceIds: profile.city.evidenceIds,
          },
    taxonomyVersion: catalog.version,
  };
}

/** Human-readable, factual summary — no chain-of-thought, no invention. */
export function composeSummary(
  context: LeadContext,
  universal: Record<string, unknown>,
  verdict: string,
): string {
  const field = (key: string): string => {
    const v = universal[key];
    if (typeof v !== 'object' || v === null) return '';
    const rec = v as { available?: boolean; value?: unknown };
    return rec.available === true && typeof rec.value === 'string' ? rec.value : '';
  };
  const parts = [field('businessType'), field('industry'), field('city')].filter((p) => p !== '');
  const specialties = Array.isArray(universal['specialties'])
    ? (universal['specialties'] as { available?: boolean; value?: string }[])
        .filter((s) => s.available === true && typeof s.value === 'string')
        .map((s) => s.value as string)
    : [];
  const all = [...parts, ...specialties].join(' / ');
  return `${context.business.canonicalName}: ${all === '' ? 'no business model detected' : all} — ${verdict}`;
}

/** Provider metadata stamped into structured_output.meta (traceability). */
export function analysisMeta(
  meta: AiMetadata,
  kind: 'HTTP' | 'FAKE' | 'RULES_FALLBACK',
  jobId: string,
  mode: string,
): Record<string, unknown> {
  return {
    provider: meta.provider,
    modelVersion: meta.modelVersion,
    promptVersion: meta.promptVersion,
    schemaVersion: meta.schemaVersion,
    providerKind: kind,
    mode: kind === 'RULES_FALLBACK' ? 'RULES_FALLBACK' : 'AI',
    jobId,
    analysisMode: mode,
    result: 'SUCCESS',
  };
}

/** Evidence ids that literally contain the hint value (rules fallback). */
export function evidenceSupportingValue(drafts: readonly EvidenceDraft[], value: string): string[] {
  const key = aliasKey(value);
  return drafts
    .filter((d) => d.content !== null && aliasKey(d.content).includes(key))
    .map((d) => d.id);
}
