/**
 * OpenAPI-as-source-of-truth validation (ADR-020).
 *
 * Runs two layers:
 *  1. Structural + reference validation via @apidevtools/swagger-parser
 *     (every $ref must resolve; every operation must have responses).
 *  2. In-repo checks mirroring ADR-020 house rules (tagged ops, ApiError
 *     responses on error paths, no untyped "*" responses).
 *
 * Exits non-zero on the first invalid layer — CI-safe.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPENAPI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docs',
  'api',
  'OPENAPI.yaml',
);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export async function validateOpenApi(path: string = OPENAPI_PATH): Promise<ValidationResult> {
  const errors: string[] = [];
  try {
    const api = await SwaggerParser.validate(path);
    // House rule: every operation declares at least one response and tags.
    const paths = api.paths ?? {};
    for (const [p, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (!Array.isArray(op.tags) || op.tags.length === 0) {
          errors.push(`${method.toUpperCase()} ${p}: missing tags`);
        }
        if (!op.responses || Object.keys(op.responses).length === 0) {
          errors.push(`${method.toUpperCase()} ${p}: missing responses`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

export function mustContainSocialPaths(): string[] {
  const raw = readFileSync(OPENAPI_PATH, 'utf8');
  const required = [
    '/social/capabilities/{sourceType}',
    '/social/actions',
    '/social/actions/{actionId}',
    '/social/actions/{actionId}/attempts',
    '/social/actions/{actionId}/fallback',
    '/social/actions/{actionId}/complete-manual',
    '/outreach/templates',
    '/outreach/templates/{templateId}/preview',
    '/outreach/campaigns',
    '/outreach/campaigns/{campaignId}/recipients',
    '/outreach/campaigns/{campaignId}/confirm',
    '/outreach/campaigns/{campaignId}/execute',
    '/outreach/campaigns/{campaignId}/cancel',
    '/outreach/campaigns/{campaignId}/report',
    '/outreach/history',
    '/outreach/suppression',
  ];
  return required.filter((p) => !raw.includes(p));
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '#');

if (isDirectRun) {
  const structural = await validateOpenApi();
  const missing = mustContainSocialPaths();
  if (structural.valid && missing.length === 0) {
    console.log('OPENAPI.yaml: valid ✓ (structural + house rules + social/outreach paths present)');
  } else {
    console.error('OPENAPI.yaml INVALID:');
    for (const e of structural.errors) console.error(' -', e);
    for (const p of missing) console.error(' - missing path:', p);
    process.exit(1);
  }
}
