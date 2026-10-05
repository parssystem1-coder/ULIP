/**
 * Normalization (Phase 15): deterministic, Persian-aware field extraction.
 *
 * Uses @ulip/domain's ADR-019 Persian normalizer for alias keys and display
 * names. Extracts taxonomy HINTS (business type / industry / specialty /
 * sub-specialty / brand / location) from common raw fields — hints only:
 * classification authority stays with the taxonomy/AI layers (Phase 08+).
 */

import { aliasKey, normalizePersian } from '@ulip/domain';
import type { NormalizedFields, Normalizer } from './contracts.ts';

const CATEGORY_TO_BUSINESS_TYPE: Readonly<Record<string, string>> = {
  WHOLESALE: 'Wholesaler',
  DISTRIBUTOR: 'Distributor',
  MANUFACTURER: 'Manufacturer',
  SERVICE: 'Service Provider',
  RETAIL: 'Retailer',
};

const KNOWN_BRANDS: readonly string[] = ['HP', 'Canon', 'Epson', 'Brother', 'Xerox', 'Ricoh', 'Kyocera'];

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Scans a biography/description for brand and specialty keywords. */
function extractHints(payload: Record<string, unknown>): Record<string, string> {
  const hints: Record<string, string> = {};

  const category = asString(payload['category']);
  if (category !== undefined) {
    const bt = CATEGORY_TO_BUSINESS_TYPE[category.toUpperCase()];
    if (bt !== undefined) hints['businessType'] = bt;
  }

  for (const key of ['brand', 'Brand']) {
    const b = asString(payload[key]);
    if (b !== undefined) {
      hints['brand'] = b;
      break;
    }
  }

  const city = asString(payload['city']) ?? asString(payload['location']);
  if (city !== undefined) hints['location'] = city;

  const text = `${asString(payload['biography']) ?? ''} ${asString(payload['description']) ?? ''}`;
  if (text.trim() !== '') {
    const upper = text.toUpperCase();
    for (const brand of KNOWN_BRANDS) {
      if (hints['brand'] === undefined && upper.includes(brand)) {
        hints['brand'] = brand;
        break;
      }
    }
    if (text.includes('قطعات پرینتر') || upper.includes('PRINTER PARTS')) hints['specialty'] = 'Printer Parts';
    else if (text.includes('رنگ مو')) hints['specialty'] = 'Hair Coloring';
    else if (text.includes('چاپ') || upper.includes('PRINT')) hints['industry'] = 'Printing';
  }

  return hints;
}

export class PersianAwareNormalizer implements Normalizer {
  normalize(entity: {
    sourceType: string;
    externalId: string;
    entityType: string;
    payload: Record<string, unknown>;
  }): NormalizedFields {
    const p = entity.payload;
    const username = asString(p['username']);
    const profileUrl = asString(p['profile_url']) ?? asString(p['external_url']);
    const rawName = asString(p['full_name']) ?? asString(p['name']) ?? asString(p['canonical_name']) ?? username ?? entity.externalId;
    const displayName = normalizePersian(rawName);
    return {
      nameKey: aliasKey(rawName),
      displayName,
      username,
      profileUrl,
      hints: extractHints(p),
    };
  }
}
