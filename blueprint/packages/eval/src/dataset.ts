/**
 * Dataset loader (Phase 17 §2).
 *
 * The dataset is a versioned JSON file committed to the repository. The loader
 * VALIDATES it before any run: a broken or non-human dataset must fail loudly
 * instead of producing misleading metrics. Pure IO + validation; no metrics.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasKey } from '@ulip/domain';
import type {
  EvalCase,
  EvalCaseTag,
  EvalDataset,
  EvalDimension,
  EvalTaxonomyAlias,
} from './contracts.ts';
import { EVAL_CASE_TAGS } from './tags.ts';

export class EvalDatasetError extends Error {
  constructor(issues: string[]) {
    super(`invalid evaluation dataset:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EvalDatasetError';
  }
}

/** Dimension → the expected-labels key it reads from. */
export const DIMENSION_TO_LABEL_KEY: Record<EvalDimension, keyof EvalCase['expected']> = {
  businessType: 'businessType',
  industry: 'industry',
  specialty: 'specialty',
  subSpecialty: 'subSpecialty',
  brand: 'brand',
  location: 'location',
};

/** Labels that are single-valued (null | string) vs set-valued (string[]). */
export function expectedLabelsFor(caseItem: EvalCase, dimension: EvalDimension): string[] {
  const key = DIMENSION_TO_LABEL_KEY[dimension];
  const value = caseItem.expected[key];
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Canonical labels of the frozen snapshot for one dimension, plus BRAND
 * aliases (brands have no taxonomy node kind) — used to distinguish
 * TAXONOMY_MISMATCH (non-canonical answer) from a plain wrong answer.
 */
export function canonicalLabelsFor(
  dataset: EvalDataset,
  dimension: EvalDimension,
): Set<string> {
  const keys = new Set<string>();
  const nodeKindOf: Record<EvalDimension, string> = {
    businessType: 'BUSINESS_TYPE',
    industry: 'INDUSTRY',
    specialty: 'SPECIALTY',
    subSpecialty: 'SUB_SPECIALTY',
    brand: 'BRAND',
    location: 'LOCATION',
  };
  if (nodeKindOf[dimension] === 'LOCATION') {
    for (const loc of dataset.locationAliases) keys.add(aliasKey(loc.city));
    return keys;
  }
  for (const node of dataset.taxonomySnapshot) {
    if (node.nodeKind === nodeKindOf[dimension]) keys.add(aliasKey(node.label));
  }
  if (dimension === 'brand') {
    for (const a of dataset.taxonomyAliases) {
      if (a.kind === 'BRAND') keys.add(aliasKey(a.label));
    }
  }
  return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a parsed dataset object; throws EvalDatasetError on any issue. */
export function validateDataset(raw: unknown): EvalDataset {
  const issues: string[] = [];
  if (!isRecord(raw)) throw new EvalDatasetError(['dataset root must be an object']);

  const datasetVersion = raw['datasetVersion'];
  if (typeof datasetVersion !== 'string' || datasetVersion.trim() === '') {
    issues.push('datasetVersion must be a non-empty string');
  }
  const provenance = raw['provenance'];
  if (typeof provenance !== 'string' || !/human/i.test(provenance)) {
    issues.push('provenance must be a human-provenance statement (must mention "human")');
  }
  const taxonomyVersion = raw['taxonomyVersion'];
  if (typeof taxonomyVersion !== 'number' || !Number.isInteger(taxonomyVersion) || taxonomyVersion < 1) {
    issues.push('taxonomyVersion must be a positive integer');
  }
  if (!Array.isArray(raw['taxonomySnapshot']) || raw['taxonomySnapshot'].length === 0) {
    issues.push('taxonomySnapshot must be a non-empty array');
  }
  if (!Array.isArray(raw['taxonomyAliases']) || raw['taxonomyAliases'].length === 0) {
    issues.push('taxonomyAliases must be a non-empty array');
  }
  if (!Array.isArray(raw['locationAliases'])) {
    issues.push('locationAliases must be an array');
  }
  if (!Array.isArray(raw['cases']) || raw['cases'].length === 0) {
    issues.push('cases must be a non-empty array');
  }
  if (issues.length > 0) throw new EvalDatasetError(issues);

  const snapshotLabels = new Set<string>();
  for (const node of raw['taxonomySnapshot'] as unknown[]) {
    if (!isRecord(node) || typeof node['nodeId'] !== 'string' || typeof node['label'] !== 'string') {
      issues.push('taxonomySnapshot entries need nodeId + label');
      continue;
    }
    snapshotLabels.add(node['label'] as string);
  }

  const aliasMap = new Map<string, EvalTaxonomyAlias>();
  for (const a of raw['taxonomyAliases'] as unknown[]) {
    if (!isRecord(a) || typeof a['label'] !== 'string' || !Array.isArray(a['aliases'])) {
      issues.push('taxonomyAliases entries need label + aliases[]');
      continue;
    }
    const kind = a['kind'];
    if (kind !== undefined && typeof kind !== 'string') {
      issues.push(`alias kind for ${a['label'] as string} must be a string`);
    }
    aliasMap.set(a['label'] as string, a as unknown as EvalTaxonomyAlias);
  }

  const cases: EvalCase[] = [];
  const seenIds = new Set<string>();
  for (const c of raw['cases'] as unknown[]) {
    if (!isRecord(c) || typeof c['caseId'] !== 'string') {
      issues.push('each case needs a string caseId');
      continue;
    }
    const caseId = c['caseId'] as string;
    if (seenIds.has(caseId)) issues.push(`duplicate caseId: ${caseId}`);
    seenIds.add(caseId);

    const tags = c['tags'];
    if (!Array.isArray(tags) || tags.length === 0) {
      issues.push(`${caseId}: tags must be a non-empty array`);
    } else {
      for (const t of tags) {
        if (typeof t !== 'string' || !(EVAL_CASE_TAGS as readonly string[]).includes(t)) {
          issues.push(`${caseId}: unknown tag ${String(t)}`);
        }
      }
    }
    if (c['locale'] !== 'fa' && c['locale'] !== 'en') {
      issues.push(`${caseId}: locale must be 'fa' or 'en'`);
    }
    const input = c['input'];
    if (!isRecord(input) || typeof input['name'] !== 'string' || (input['name'] as string).trim() === '') {
      issues.push(`${caseId}: input.name must be a non-empty string`);
    }
    const expected = c['expected'];
    if (!isRecord(expected)) {
      issues.push(`${caseId}: expected labels object is required`);
      continue;
    }
    for (const key of ['businessType', 'industry', 'location'] as const) {
      const v = expected[key];
      if (v !== null && typeof v !== 'string') issues.push(`${caseId}: expected.${key} must be a string or null`);
    }
    for (const key of ['specialty', 'subSpecialty', 'brand'] as const) {
      const v = expected[key];
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
        issues.push(`${caseId}: expected.${key} must be a string[]`);
      }
    }
    const hasLabel = (
      ['businessType', 'industry', 'location'] as const
    ).some((k) => typeof expected[k] === 'string' && expected[k] !== null) ||
      (['specialty', 'subSpecialty', 'brand'] as const).some(
        (k) => Array.isArray(expected[k]) && (expected[k] as string[]).length > 0,
      );
    const hasOutcome =
      c['expectedOutcome'] === 'QUALIFIED' ||
      c['expectedOutcome'] === 'REVIEW_REQUIRED' ||
      c['expectedOutcome'] === 'REJECTED' ||
      c['expectedOutcome'] === undefined;
    if (!hasOutcome) issues.push(`${caseId}: expectedOutcome must be QUALIFIED|REVIEW_REQUIRED|REJECTED`);
    if (!hasLabel && c['expectedOutcome'] === undefined) {
      issues.push(`${caseId}: needs at least one expected label or an expectedOutcome`);
    }
    // Human labels must reference canonical snapshot labels (brands excepted).
    for (const key of ['businessType', 'industry'] as const) {
      const v = expected[key];
      if (typeof v === 'string' && v !== null && !snapshotLabels.has(v)) {
        issues.push(`${caseId}: expected.${key} "${v}" is not a snapshot label`);
      }
    }
    cases.push(c as unknown as EvalCase);
  }

  // Alias sanity: every non-BRAND alias label must exist in the snapshot.
  for (const [label, alias] of aliasMap) {
    if (alias.kind === 'BRAND') continue;
    if (!snapshotLabels.has(label)) issues.push(`alias label "${label}" is not a taxonomy snapshot label`);
  }

  if (issues.length > 0) throw new EvalDatasetError(issues);
  return raw as unknown as EvalDataset;
}

/** Parses and validates a dataset from a JSON string. */
export function parseDataset(json: string): EvalDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (err) {
    throw new EvalDatasetError([`dataset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return validateDataset(raw);
}

/** Path of the committed default dataset (package-local, versioned). */
export function defaultDatasetPath(version = 'v1'): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'dataset', `eval-dataset-${version}.json`);
}

/** Loads the committed default dataset. */
export function loadDefaultDataset(version = 'v1'): EvalDataset {
  return parseDataset(readFileSync(defaultDatasetPath(version), 'utf8'));
}
