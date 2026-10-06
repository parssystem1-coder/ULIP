/**
 * AI runtime configuration (Phase 16).
 *
 * Provider-agnostic by construction: the platform never hard-codes a vendor.
 * Everything an HTTP adapter needs comes from the environment:
 *
 *   AI_PROVIDER            http | fake | none            (default: http)
 *   AI_BASE_URL            OpenAI-compatible base URL     (e.g. https://api.openai.com/v1)
 *   AI_API_KEY             bearer token (optional for local servers)
 *   AI_MODEL               model name (required for http)
 *   AI_TIMEOUT_MS          per-request timeout            (default 30000)
 *   AI_MAX_RETRIES         transport retries              (default 2)
 *   AI_RETRY_BACKOFF_MS    base backoff                   (default 500)
 *   AI_PROMPT_VERSION      prompt/task version tag        (default ulip-extract-v1)
 *   AI_SCHEMA_VERSION      output schema version tag      (default 1)
 *   AI_VISION_MODEL        enables the optional vision slot (same base/key)
 *   AI_EMBEDDING_MODEL     enables the optional embedding slot (same base/key)
 *
 * SEMANTICS
 *  - Malformed values (bad URL, out-of-range numbers, unknown provider) throw
 *    AiConfigError at load time — fail fast, before the process serves.
 *  - Well-formed but INCOMPLETE configuration is NOT an error: the runtime
 *    reports NOT_CONFIGURED and the worker refuses to fabricate an AI run.
 *  - The deterministic fake provider is never selected silently: it requires
 *    AI_PROVIDER=fake AND (NODE_ENV != production OR an explicit allowFake).
 *
 * No `unknown` in public contracts (ADR-023).
 */

import { z } from 'zod';

export const AiProviderKindSchema = z.enum(['http', 'fake', 'none']);
export type AiProviderKind = z.infer<typeof AiProviderKindSchema>;

export const AiConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AI_PROVIDER: AiProviderKindSchema.default('http'),
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  AI_PROMPT_VERSION: z.string().min(1).default('ulip-extract-v1'),
  AI_SCHEMA_VERSION: z.string().min(1).default('1'),
  AI_PROVIDER_NAME: z.string().min(1).optional(),
  AI_VISION_MODEL: z.string().min(1).optional(),
  AI_EMBEDDING_MODEL: z.string().min(1).optional(),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;

export class AiConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid AI configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'AiConfigError';
    this.issues = issues;
  }
}

/**
 * Parses + validates AI environment configuration.
 * Throws AiConfigError on malformed values; missing credentials are NOT an
 * error here (they surface as NOT_CONFIGURED at selection time).
 */
export function loadAiConfig(source: NodeJS.ProcessEnv = process.env): AiConfig {
  const result = AiConfigSchema.safeParse(source);
  if (!result.success) {
    throw new AiConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const cfg = result.data;

  // Production must not talk to an endpoint in plain HTTP.
  if (cfg.NODE_ENV === 'production' && cfg.AI_BASE_URL !== undefined && !cfg.AI_BASE_URL.startsWith('https://')) {
    throw new AiConfigError(['AI_BASE_URL: must be https:// in production']);
  }
  return cfg;
}

/** Human-readable list of missing pieces for a given provider kind. */
export function missingCredentials(config: AiConfig): string[] {
  const missing: string[] = [];
  if (config.AI_PROVIDER === 'http') {
    if (config.AI_BASE_URL === undefined) missing.push('AI_BASE_URL');
    if (config.AI_MODEL === undefined) missing.push('AI_MODEL');
    if (config.AI_API_KEY === undefined || config.AI_API_KEY === '') missing.push('AI_API_KEY');
  }
  return missing;
}

/** Stable, vendor-neutral provider name for logs/DB rows (never a secret). */
export function providerNameFor(config: AiConfig): string {
  if (config.AI_PROVIDER_NAME !== undefined) return config.AI_PROVIDER_NAME;
  if (config.AI_PROVIDER === 'fake') return 'fake:deterministic';
  if (config.AI_PROVIDER === 'none') return 'none';
  const base = config.AI_BASE_URL ?? '';
  try {
    return `http:${new URL(base).host}`;
  } catch {
    return 'http:unconfigured';
  }
}
