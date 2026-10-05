/**
 * Runtime configuration & environment validation (Phase 14).
 *
 * Fail-fast: the process must not start with an invalid environment.
 * Secrets are never logged and never defaulted to non-placeholder values.
 */

import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('ulip'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://postgres:postgres@localhost:5432/ulip'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 chars'),
  BOOTSTRAP_API_KEY: z.string().min(16, 'BOOTSTRAP_API_KEY must be at least 16 chars'),

  ULIP_PG_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid environment:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/** Parses + validates environment; throws EnvValidationError on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
