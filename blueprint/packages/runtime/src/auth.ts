/**
 * Authentication boundary primitives (Phase 14).
 *
 * API-key authentication: `Authorization: Bearer <apiKey>`. Keys are stored
 * as SHA-256 hashes (migration 0003 adds `users.api_key_hash`); lookup is by
 * hash. The resolved tenant becomes the request's tenant context — never
 * client-supplied.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export interface Principal {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** Constant-time comparison for hash equality. */
export function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export class UnauthorizedError extends Error {
  constructor(reason = 'missing or invalid credentials') {
    super(reason);
    this.name = 'UnauthorizedError';
  }
}
