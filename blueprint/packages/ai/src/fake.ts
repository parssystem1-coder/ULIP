/**
 * Deterministic fake AI provider (Phase 16) — TEST/DEV ONLY.
 *
 * Purpose: give local and integration tests a predictable, honest AI runtime
 * without external credentials. It never fabricates: every claim it emits
 * cites an evidence sample whose text actually contains the matched signal,
 * so the evidence-first validation in validation.ts holds by construction.
 *
 * Selection rules (see factory.ts): it is NEVER chosen silently in
 * production — AI_PROVIDER=fake must be explicit, and production additionally
 * requires an explicit allowFake opt-in.
 *
 * Determinism: keyword dictionaries are fixed, confidences are constants,
 * iteration order is stable → the same input always yields the same output.
 */

import type {
  AiMetadata,
  ExtractionResult,
  FieldPrediction,
  LLMProvider,
  ParsedSearchQuery,
  ProfileExtractionInput,
  StructuredProfile,
} from './interfaces.ts';
import type { TaxonomyOption } from './interfaces.ts';
import type { LeadSearchFilters } from '@ulip/domain/contracts';
import { aliasKey } from '@ulip/domain';

interface Rule {
  /** Canonical ULIP label for the concept. */
  label: string;
  /** Trigger keywords (lowercased, matched on normalized text). */
  keywords: readonly string[];
  confidence: number;
}

const BUSINESS_TYPES: readonly Rule[] = [
  { label: 'Wholesaler', keywords: ['wholesaler', 'wholesale', 'عمده فروش', 'عمده‌فروش'], confidence: 0.92 },
  { label: 'Distributor', keywords: ['distributor', 'distribution', 'توزیع کننده', 'پخش کننده'], confidence: 0.9 },
  { label: 'Manufacturer', keywords: ['manufacturer', 'manufacturing', 'تولیدی', 'سازنده'], confidence: 0.9 },
  { label: 'Retailer', keywords: ['retailer', 'retail', 'خرده فروشی', 'فروشگاه'], confidence: 0.9 },
  { label: 'Service Provider', keywords: ['service provider', 'salon', 'آرایشگاه', 'سالن زیبایی', 'خدمات'], confidence: 0.92 },
];

const INDUSTRIES: readonly Rule[] = [
  { label: 'Printing', keywords: ['printer', 'printing', 'print shop', 'چاپ', 'پرینتر'], confidence: 0.9 },
  { label: 'Beauty', keywords: ['beauty', 'hair salon', 'hair coloring', 'آرایشگاه', 'زیبایی', 'رنگ مو'], confidence: 0.9 },
  { label: 'Automotive', keywords: ['auto parts', 'خودرو', 'لوازم یدکی'], confidence: 0.88 },
  { label: 'Electronics', keywords: ['electronics', 'electronic', 'الکترونیک'], confidence: 0.88 },
  { label: 'Food & Beverage', keywords: ['restaurant', 'cafe', 'رستوران', 'کافه'], confidence: 0.88 },
];

const SPECIALTIES: readonly Rule[] = [
  { label: 'Printer Parts', keywords: ['printer parts', 'قطعات پرینتر', 'پرینتر'], confidence: 0.88 },
  { label: 'Balayage', keywords: ['balayage', 'بالایاژ'], confidence: 0.9 },
  { label: 'Hair Coloring', keywords: ['hair coloring', 'hair color', 'رنگ مو', 'coloring'], confidence: 0.88 },
  { label: 'Nail Art', keywords: ['nail art', 'ناخن'], confidence: 0.86 },
  { label: 'Skin Care', keywords: ['skin care', 'مراقبت پوست', 'پوست'], confidence: 0.86 },
];

const BRANDS: readonly string[] = ['HP', 'Canon', 'Epson', 'Brother', 'Xerox', 'Ricoh', 'Kyocera', 'Samsung'];

const CITIES: Readonly<Record<string, string>> = {
  tehran: 'Tehran',
  تهران: 'Tehran',
  shiraz: 'Shiraz',
  شیراز: 'Shiraz',
  isfahan: 'Isfahan',
  اصفهان: 'Isfahan',
  mashhad: 'Mashhad',
  مشهد: 'Mashhad',
  tabriz: 'Tabriz',
  تبریز: 'Tabriz',
  karaj: 'Karaj',
  کرج: 'Karaj',
  ahvaz: 'Ahvaz',
  اهواز: 'Ahvaz',
  qom: 'Qom',
  قم: 'Qom',
  kerman: 'Kerman',
  کرمان: 'Kerman',
  rasht: 'Rasht',
  رشت: 'Rasht',
};

const FAKE_META_BASE = {
  promptVersion: 'fake-deterministic-v1',
  schemaVersion: '1',
};

/** Canonicalizes Persian/Arabic characters + ZWNJ for stable keyword matching. */
function normalizeText(text: string): string {
  return aliasKey(text);
}

interface SampleRef {
  id: string;
  raw: string;
  normalized: string;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All sample ids whose text contains the keyword (sorted → deterministic). */
function supportingIds(samples: readonly SampleRef[], keyword: string): string[] {
  return samples.filter((s) => s.normalized.includes(keyword)).map((s) => s.id).sort();
}

function firstMatch(
  samples: readonly SampleRef[],
  rules: readonly Rule[],
): { rule: Rule; evidenceIds: string[] } | null {
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      const ids = supportingIds(samples, normalizeText(keyword));
      if (ids.length > 0) return { rule, evidenceIds: ids };
    }
  }
  return null;
}

function matchesTaxonomy(
  snapshot: readonly TaxonomyOption[],
  kind: TaxonomyOption['nodeKind'],
  label: string,
): string | null {
  const key = aliasKey(label);
  const hit = snapshot.find((o) => o.nodeKind === kind && aliasKey(o.label) === key);
  return hit?.nodeId ?? null;
}

function prediction(
  snapshot: readonly TaxonomyOption[],
  kind: TaxonomyOption['nodeKind'],
  label: string,
  confidence: number,
  evidenceIds: string[],
): FieldPrediction {
  const nodeId = matchesTaxonomy(snapshot, kind, label);
  return {
    value: nodeId ?? label,
    confidence,
    evidenceIds,
    availability: 'AVAILABLE',
  };
}

export class DeterministicFakeLlmProvider implements LLMProvider {
  /** Drives factory gating, mirroring the deterministic fake connector. */
  readonly isDeterministicFake = true;
  private readonly providerName: string;
  private readonly modelVersion: string;

  constructor(providerName = 'fake:deterministic', modelVersion = 'fake-1') {
    this.providerName = providerName;
    this.modelVersion = modelVersion;
  }

  metadata(): AiMetadata {
    return {
      provider: this.providerName,
      modelVersion: this.modelVersion,
      ...FAKE_META_BASE,
    };
  }

  async extractStructuredProfile(input: ProfileExtractionInput): Promise<ExtractionResult> {
    // Evidence-first by construction: only citable samples are scanned.
    const samples: SampleRef[] = input.contentSamples.map((s) => ({
      id: s.contentId,
      raw: `${s.text ?? ''}`,
      normalized: normalizeText(`${s.text ?? ''}`),
    }));

    const profile: StructuredProfile = { specialties: [] };

    const bt = firstMatch(samples, BUSINESS_TYPES);
    if (bt !== null) {
      profile.businessType = prediction(
        input.taxonomySnapshot,
        'BUSINESS_TYPE',
        bt.rule.label,
        bt.rule.confidence,
        bt.evidenceIds,
      );
    }

    const ind = firstMatch(samples, INDUSTRIES);
    if (ind !== null) {
      profile.industry = prediction(
        input.taxonomySnapshot,
        'INDUSTRY',
        ind.rule.label,
        ind.rule.confidence,
        ind.evidenceIds,
      );
    }

    for (const rule of SPECIALTIES) {
      let ids: string[] = [];
      for (const keyword of rule.keywords) {
        ids = supportingIds(samples, normalizeText(keyword));
        if (ids.length > 0) break;
      }
      if (ids.length === 0) continue;
      profile.specialties.push(
        prediction(input.taxonomySnapshot, 'SPECIALTY', rule.label, rule.confidence, ids),
      );
    }

    const brandHits: { label: string; evidenceIds: string[] }[] = [];
    for (const brand of BRANDS) {
      const wordRe = new RegExp(`(?<![a-z0-9])${escapeRe(brand)}(?![a-z0-9])`, 'i');
      const ids = samples.filter((s) => wordRe.test(s.raw)).map((s) => s.id).sort();
      if (ids.length > 0 && brandHits.every((b) => b.label !== brand)) {
        brandHits.push({ label: brand, evidenceIds: ids });
      }
    }
    if (brandHits.length > 0) {
      profile.brands = brandHits.map((b) => ({
        value: b.label,
        confidence: 0.9,
        evidenceIds: b.evidenceIds.sort(),
        availability: 'AVAILABLE' as const,
      }));
    }

    for (const [alias, canonical] of Object.entries(CITIES)) {
      const ids = supportingIds(samples, normalizeText(alias));
      if (ids.length > 0) {
        profile.city = {
          value: canonical,
          confidence: 0.86,
          evidenceIds: ids,
          availability: 'AVAILABLE',
          provenance: 'EXPLICIT',
        };
        break;
      }
    }

    return { profile, meta: this.metadata() };
  }

  async parseSearchQuery(input: { text: string; locale: string }): Promise<ParsedSearchQuery> {
    const normalized = normalizeText(input.text);
    const words = input.text.split(/\s+/).filter((w) => w.trim() !== '');
    const filters: LeadSearchFilters = {};
    const unmatchedTerms: string[] = [];
    let matched = 0;

    for (const rule of BUSINESS_TYPES) {
      if (rule.keywords.some((k) => normalized.includes(normalizeText(k)))) {
        filters.businessTypes = [rule.label];
        matched += 1;
        break;
      }
    }
    for (const rule of SPECIALTIES) {
      if (rule.keywords.some((k) => normalized.includes(normalizeText(k)))) {
        filters.specialties = [...(filters.specialties ?? []), rule.label];
        matched += 1;
        break;
      }
    }
    for (const brand of BRANDS) {
      if (normalized.includes(normalizeText(brand))) {
        filters.brands = [...(filters.brands ?? []), brand];
        matched += 1;
        break;
      }
    }
    for (const [alias, canonical] of Object.entries(CITIES)) {
      if (normalized.includes(normalizeText(alias))) {
        filters.city = canonical;
        matched += 1;
        break;
      }
    }
    if (matched === 0) unmatchedTerms.push(...words.slice(0, 5));

    return {
      filters,
      confidence: matched > 0 ? 0.9 : 0.3,
      unmatchedTerms,
      meta: this.metadata(),
    };
  }

  async summarize(input: { text: string; maxPoints: number }): Promise<{ summary: string; meta: AiMetadata }> {
    const sentences = input.text
      .split(/(?<=[.!?؟])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .slice(0, Math.max(1, input.maxPoints));
    return { summary: sentences.map((s) => `- ${s}`).join('\n'), meta: this.metadata() };
  }
}
