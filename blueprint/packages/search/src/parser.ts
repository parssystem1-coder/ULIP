/**
 * Deterministic rules-based fallback parser (Phase 20) — Persian first.
 *
 * Used when the AI runtime is NOT_CONFIGURED so NL search stays honest and
 * usable without credentials: no fabrication, fixed keyword dictionaries,
 * Persian-aware normalization via @ulip/domain. Emits exactly the same shape
 * the LLM parser emits (`LeadSearchFilters`) — never SQL, never free-form
 * expressions.
 *
 * Determinism: dictionaries are fixed; iteration order is stable; the same
 * input always produces the same output.
 */

import { aliasKey, guessLocale } from '@ulip/domain';
import type { LeadSearchFilters, LeadStatus } from '@ulip/domain/contracts';
import type { ParsedQuery, QueryParser } from './contracts.ts';

interface Rule {
  label: string;
  keywords: readonly string[];
  confidence: number;
}

const BUSINESS_TYPES: readonly Rule[] = [
  { label: 'Wholesaler', keywords: ['wholesaler', 'wholesale', 'عمده فروش', 'عمده\u200cفروش', 'عمده فروشی'], confidence: 0.85 },
  { label: 'Distributor', keywords: ['distributor', 'distribution', 'توزیع کننده', 'پخش کننده'], confidence: 0.82 },
  { label: 'Manufacturer', keywords: ['manufacturer', 'manufacturing', 'تولیدی', 'سازنده'], confidence: 0.82 },
  { label: 'Retailer', keywords: ['retailer', 'retail', 'خرده فروشی', 'فروشگاه'], confidence: 0.8 },
  { label: 'Service Provider', keywords: ['service provider', 'salon', 'آرایشگاه', 'سالن زیبایی', 'خدمات'], confidence: 0.82 },
];

const INDUSTRIES: readonly Rule[] = [
  { label: 'Printing', keywords: ['printer', 'printing', 'print shop', 'چاپ', 'پرینتر'], confidence: 0.82 },
  { label: 'Beauty', keywords: ['beauty', 'hair salon', 'hair coloring', 'آرایشگاه', 'زیبایی', 'رنگ مو'], confidence: 0.82 },
  { label: 'Automotive', keywords: ['auto parts', 'خودرو', 'لوازم یدکی'], confidence: 0.8 },
  { label: 'Electronics', keywords: ['electronics', 'electronic', 'الکترونیک'], confidence: 0.8 },
  { label: 'Food & Beverage', keywords: ['restaurant', 'cafe', 'رستوران', 'کافه'], confidence: 0.8 },
];

const SPECIALTIES: readonly Rule[] = [
  { label: 'Printer Parts', keywords: ['printer parts', 'قطعات پرینتر', 'قطعات پرینتر'], confidence: 0.8 },
  { label: 'Balayage', keywords: ['balayage', 'بالایاژ'], confidence: 0.82 },
  { label: 'Hair Coloring', keywords: ['hair coloring', 'hair color', 'رنگ مو'], confidence: 0.8 },
  { label: 'Nail Art', keywords: ['nail art', 'ناخن'], confidence: 0.78 },
  { label: 'Skin Care', keywords: ['skin care', 'مراقبت پوست', 'پوست'], confidence: 0.78 },
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

const LEAD_STATUSES: readonly string[] = [
  'DISCOVERED', 'RAW_STORED', 'NORMALIZED', 'DEDUP_CHECKED', 'ANALYSIS_PENDING',
  'ANALYZING', 'SCORED', 'REVIEW_REQUIRED', 'QUALIFIED', 'REJECTED', 'FAILED', 'ARCHIVED',
];

/** Light stopwords so leftover function words do not pollute content matching. */
const STOPWORDS: readonly string[] = [
  'در', 'از', 'با', 'برای', 'که', 'را', 'و', 'the', 'in', 'for', 'with', 'and', 'of', 'a', 'an',
];

const MAX_TEXT_LENGTH = 1000;

export function normalizeForMatching(text: string): string {
  return aliasKey(text);
}

export function stopwords(): readonly string[] {
  return STOPWORDS;
}

export class DeterministicQueryParser implements QueryParser {
  readonly isDeterministicRulesParser = true;

  async parse(input: { text: string; locale: string }): Promise<ParsedQuery> {
    const text = input.text.slice(0, MAX_TEXT_LENGTH);
    const normalized = normalizeForMatching(text);
    const words = text.split(/\s+/).filter((w) => w.trim() !== '');
    const filters: LeadSearchFilters = {};
    const unmatchedTerms: string[] = [];
    let matched = 0;

    for (const rule of BUSINESS_TYPES) {
      if (rule.keywords.some((k) => normalized.includes(normalizeForMatching(k)))) {
        filters.businessTypes = [rule.label];
        matched += 1;
        break;
      }
    }
    for (const rule of INDUSTRIES) {
      if (rule.keywords.some((k) => normalized.includes(normalizeForMatching(k)))) {
        filters.industries = [rule.label];
        matched += 1;
        break;
      }
    }
    for (const rule of SPECIALTIES) {
      if (rule.keywords.some((k) => normalized.includes(normalizeForMatching(k)))) {
        filters.specialties = [...(filters.specialties ?? []), rule.label];
        matched += 1;
        break;
      }
    }
    for (const brand of BRANDS) {
      if (normalized.includes(normalizeForMatching(brand))) {
        filters.brands = [...(filters.brands ?? []), brand];
        matched += 1;
        break;
      }
    }
    for (const [alias, canonical] of Object.entries(CITIES)) {
      if (normalized.includes(normalizeForMatching(alias))) {
        filters.city = canonical;
        matched += 1;
        break;
      }
    }
    for (const status of LEAD_STATUSES as readonly LeadStatus[]) {
      if (normalized.includes(normalizeForMatching(status))) {
        filters.status = status;
        matched += 1;
        break;
      }
    }

    // Whatever no dictionary captured becomes honest unmatched terms, minus
    // function words that would pollute content matching.
    const unknown = words.filter((w) => {
      const key = normalizeForMatching(w);
      if (key === '' || STOPWORDS.includes(key)) return false;
      return ![...BUSINESS_TYPES, ...INDUSTRIES, ...SPECIALTIES].some((r) =>
        r.keywords.some((k) => normalizeForMatching(k).includes(key) || key.includes(normalizeForMatching(k))),
      ) && !BRANDS.some((b) => normalizeForMatching(b) === key) && !Object.keys(CITIES).some((c) => normalizeForMatching(c) === key);
    });
    unmatchedTerms.push(...unknown.slice(0, 5));

    const persianChars = (text.match(/[\u0600-\u06FF]/g)?.length ?? 0);
    const latinChars = (text.match(/[A-Za-z]/g)?.length ?? 0);
    const locale: ParsedQuery['locale'] = persianChars > 0 && latinChars > 0 ? 'mixed' : guessLocale(text);

    return {
      filters,
      confidence: matched > 0 ? 0.75 : 0.2,
      unmatchedTerms,
      locale,
      parserKind: 'RULES_FALLBACK',
      parserProvider: 'rules:deterministic',
      parserModelVersion: 'rules-fallback-1',
    };
  }
}
