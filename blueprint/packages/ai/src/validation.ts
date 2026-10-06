/**
 * AI task-contract validation (Phase 16, ADR-008 evidence-first).
 *
 * Provider output is NEVER trusted: the gateway validates it against the
 * typed contract in interfaces.ts before anything is persisted.
 *
 * Two layers:
 *  1. `validateExtractionOutput` — structural + semantic checks
 *     (confidence ranges, availability enum, evidence ids that must exist in
 *     the request, provenance for city, no empty values).
 *  2. `enforceEvidenceFirst` — defensive demotion of any field whose evidence
 *     references are missing/unknown: the field becomes explicitly
 *     UNAVAILABLE instead of being persisted as a fact.
 *
 * Missing `availability` is normalized to INFERRED (never presented as fact).
 */

import type {
  CityPrediction,
  ExtractionResult,
  FieldPrediction,
  ProfileExtractionInput,
  StructuredProfile,
  TaxonomyOption,
} from './interfaces.ts';
import type { Availability } from '@ulip/domain/contracts';
import type { AiMetadata } from './interfaces.ts';
import type { ValidationResult } from './interfaces.ts';

const AVAILABILITIES: readonly string[] = ['AVAILABLE', 'PARTIAL', 'INFERRED', 'UNAVAILABLE'];
const PROVENANCES: readonly string[] = ['EXPLICIT', 'INFERRED', 'UNKNOWN'];

const MAX_SPECIALTIES = 10;
const MAX_BRANDS = 10;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sampleIds(input: ProfileExtractionInput): Set<string> {
  return new Set(input.contentSamples.map((s) => s.contentId));
}

function checkPrediction(
  path: string,
  raw: unknown,
  ids: Set<string>,
  errors: string[],
): FieldPrediction | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    errors.push(`${path}: must be an object { value, confidence, evidenceIds, availability }`);
    return null;
  }
  const value = raw['value'];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path}.value: non-empty string required`);
    return null;
  }
  const confidence = raw['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push(`${path}.confidence: must be a finite number in [0,1] (got ${String(confidence)})`);
    return null;
  }
  const evidenceRaw = raw['evidenceIds'];
  if (!Array.isArray(evidenceRaw) || evidenceRaw.some((e) => typeof e !== 'string')) {
    errors.push(`${path}.evidenceIds: must be an array of evidence ids`);
    return null;
  }
  const evidenceIds = evidenceRaw as string[];
  const availabilityRaw = raw['availability'];
  const availability: Availability =
    availabilityRaw === undefined
      ? 'INFERRED'
      : (String(availabilityRaw) as Availability);
  if (!AVAILABILITIES.includes(availability)) {
    errors.push(`${path}.availability: must be one of ${AVAILABILITIES.join('/')}`);
    return null;
  }
  for (const id of evidenceIds) {
    if (!ids.has(id)) errors.push(`${path}.evidenceIds: unknown evidence id ${id}`);
  }
  if (availability !== 'UNAVAILABLE' && evidenceIds.length === 0) {
    errors.push(`${path}: claimed value needs at least one evidence reference (evidence-first rule)`);
  }
  return { value: value.trim(), confidence, evidenceIds, availability };
}

function checkCity(
  path: string,
  raw: unknown,
  ids: Set<string>,
  errors: string[],
): CityPrediction | null {
  const base = checkPrediction(path, raw, ids, errors);
  if (base === null) return null;
  const provenanceRaw = (raw as Record<string, unknown>)['provenance'];
  const provenance = provenanceRaw === undefined ? 'INFERRED' : String(provenanceRaw);
  if (!PROVENANCES.includes(provenance)) {
    errors.push(`${path}.provenance: must be one of ${PROVENANCES.join('/')}`);
    return null;
  }
  return { ...base, provenance: provenance as CityPrediction['provenance'] };
}

/**
 * Validates raw provider output against the StructuredProfile contract.
 * Returns `{ ok: false, errors }` on any violation — the caller then applies
 * bounded repair/retry (SCHEMA_VALIDATION_ERROR path).
 */
export function validateExtractionOutput(
  input: ProfileExtractionInput,
  raw: unknown,
): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['output must be a JSON object'] };
  }
  const ids = sampleIds(input);

  if (raw['businessType'] !== undefined) checkPrediction('businessType', raw['businessType'], ids, errors);
  if (raw['industry'] !== undefined) checkPrediction('industry', raw['industry'], ids, errors);

  const specialties = raw['specialties'];
  if (specialties !== undefined) {
    if (!Array.isArray(specialties)) {
      errors.push('specialties: must be an array');
    } else {
      if (specialties.length > MAX_SPECIALTIES) errors.push(`specialties: at most ${MAX_SPECIALTIES} entries`);
      specialties.forEach((s, i) => checkPrediction(`specialties[${i}]`, s, ids, errors));
    }
  }

  const brands = raw['brands'];
  if (brands !== undefined) {
    if (!Array.isArray(brands)) {
      errors.push('brands: must be an array');
    } else {
      if (brands.length > MAX_BRANDS) errors.push(`brands: at most ${MAX_BRANDS} entries`);
      brands.forEach((b, i) => checkPrediction(`brands[${i}]`, b, ids, errors));
    }
  }

  if (raw['city'] !== undefined) checkCity('city', raw['city'], ids, errors);

  return { ok: errors.length === 0, errors };
}

function demote(path: string, p: FieldPrediction, demoted: string[]): FieldPrediction {
  demoted.push(path);
  return { ...p, confidence: 0, availability: 'UNAVAILABLE', evidenceIds: [] };
}

export interface EvidenceFirstResult {
  profile: StructuredProfile;
  /** Field paths that were demoted to UNAVAILABLE (reported as uncertain). */
  demoted: string[];
}

/**
 * Defensive evidence-first pass: any field that is not UNAVAILABLE but lacks a
 * VALID evidence reference is demoted to UNAVAILABLE with confidence 0.
 * Unsupported inference never becomes a fact (ADR-008).
 */
export function enforceEvidenceFirst(
  profile: StructuredProfile,
  ids: Set<string>,
): EvidenceFirstResult {
  const demoted: string[] = [];
  const keep = (p: FieldPrediction): boolean =>
    p.availability !== 'UNAVAILABLE' && p.evidenceIds.length > 0 && p.evidenceIds.every((id) => ids.has(id));

  const out: StructuredProfile = { specialties: [] };

  if (profile.businessType !== undefined) {
    out.businessType = keep(profile.businessType)
      ? profile.businessType
      : demote('businessType', profile.businessType, demoted);
    if (out.businessType.availability === 'UNAVAILABLE' && profile.businessType.availability !== 'UNAVAILABLE') {
      // keep the observed value visible as an UNCERTAIN note, never as a fact
      out.businessType = { ...out.businessType, value: profile.businessType.value };
    }
  }
  if (profile.industry !== undefined) {
    out.industry = keep(profile.industry) ? profile.industry : demote('industry', profile.industry, demoted);
    if (out.industry.availability === 'UNAVAILABLE' && profile.industry.availability !== 'UNAVAILABLE') {
      out.industry = { ...out.industry, value: profile.industry.value };
    }
  }
  profile.specialties.forEach((s, i) => {
    const next = keep(s) ? s : demote(`specialties[${i}]`, s, demoted);
    out.specialties.push(
      next.availability === 'UNAVAILABLE' && s.availability !== 'UNAVAILABLE'
        ? { ...next, value: s.value }
        : next,
    );
  });
  if (profile.brands !== undefined) {
    out.brands = profile.brands.map((b, i) =>
      keep(b) ? b : { ...demote(`brands[${i}]`, b, demoted), value: b.value },
    );
  }
  if (profile.city !== undefined) {
    const city = keep(profile.city)
      ? profile.city
      : { ...demote('city', profile.city, demoted), provenance: 'UNKNOWN' as const };
    out.city =
      city.availability === 'UNAVAILABLE' && profile.city.availability !== 'UNAVAILABLE'
        ? { ...city, value: profile.city.value }
        : city;
  }
  return { profile: out, demoted };
}

/**
 * Builds a typed StructuredProfile from VALIDATED raw output.
 * Missing availability is normalized to INFERRED (never presented as fact).
 */
export function parseExtractionProfile(raw: unknown): StructuredProfile {
  const r = isRecord(raw) ? raw : {};
  const prediction = (v: unknown): FieldPrediction | undefined => {
    if (!isRecord(v)) return undefined;
    const value = typeof v['value'] === 'string' ? v['value'].trim() : '';
    if (value === '') return undefined;
    const confidence = typeof v['confidence'] === 'number' ? v['confidence'] : 0;
    const evidenceIds = Array.isArray(v['evidenceIds'])
      ? (v['evidenceIds'] as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    const availability = AVAILABILITIES.includes(String(v['availability']))
      ? (String(v['availability']) as Availability)
      : 'INFERRED';
    return { value, confidence, evidenceIds, availability };
  };

  const profile: StructuredProfile = { specialties: [] };
  const businessType = prediction(r['businessType']);
  if (businessType !== undefined) profile.businessType = businessType;
  const industry = prediction(r['industry']);
  if (industry !== undefined) profile.industry = industry;
  if (Array.isArray(r['specialties'])) {
    profile.specialties = (r['specialties'] as unknown[])
      .map(prediction)
      .filter((p): p is FieldPrediction => p !== undefined)
      .slice(0, MAX_SPECIALTIES);
  }
  if (Array.isArray(r['brands'])) {
    profile.brands = (r['brands'] as unknown[])
      .map(prediction)
      .filter((p): p is FieldPrediction => p !== undefined)
      .slice(0, MAX_BRANDS);
  }
  const cityRaw = r['city'];
  if (isRecord(cityRaw)) {
    const city = prediction(cityRaw);
    if (city !== undefined) {
      const provenance = PROVENANCES.includes(String(cityRaw['provenance']))
        ? (String(cityRaw['provenance']) as CityPrediction['provenance'])
        : 'INFERRED';
      profile.city = { ...city, provenance };
    }
  }
  return profile;
}

/** Wraps a validated profile into the contract's ExtractionResult. */
export function toExtractionResult(
  profile: StructuredProfile,
  meta: AiMetadata,
): ExtractionResult {
  return { profile, meta };
}

/** Taxonomy snapshot as a compact, deterministic prompt block. */
export function taxonomySnapshotBlock(options: readonly TaxonomyOption[]): string {
  return options.map((o) => `${o.nodeKind}: ${o.nodeId} = ${o.label}`).join('\n');
}
