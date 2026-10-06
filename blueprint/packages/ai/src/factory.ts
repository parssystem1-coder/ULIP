/**
 * AI runtime selection (Phase 16) — the single place a provider is chosen.
 *
 * Provider-agnostic: the platform never hard-codes a vendor, only the
 * configured transport (OpenAI-compatible HTTP) plus the deterministic fake
 * for tests/local E2E.
 *
 * Honest states:
 *  - READY            → llm (and optionally vision/embedding) available
 *  - NOT_CONFIGURED   → no credentials / fake refused in production.
 *                       NOTHING is fabricated in this state; the worker must
 *                       fail the job with a clear reason instead.
 *
 * The DecisionProvider (Jev) stays OPTIONAL and is never required to run
 * analysis (ADR-017); it is only attached when a caller supplies one.
 */

import type {
  DecisionProvider,
  EmbeddingProvider,
  LLMProvider,
  VisionProvider,
} from './interfaces.ts';
import { AiNotConfiguredError, AiUnavailableError } from './errors.ts';
import { loadAiConfig, missingCredentials, providerNameFor, type AiConfig } from './config.ts';
import type { FetchLike } from './http.ts';
import { HttpLlmProvider } from './http-llm.ts';
import { HttpEmbeddingProvider, HttpVisionProvider } from './http-providers.ts';
import { DeterministicFakeLlmProvider } from './fake.ts';
import { DeterministicFakeVisionProvider } from './fake-vision.ts';

export type AiRuntimeStatus = 'READY' | 'NOT_CONFIGURED';

export interface AiRuntimeMeta {
  kind: 'HTTP' | 'FAKE' | 'NONE';
  provider: string;
  modelVersion: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface AiRuntime {
  status: AiRuntimeStatus;
  /** Machine-readable reason when status is NOT_CONFIGURED. */
  reason?: string;
  /** Missing environment keys (empty when READY). */
  missing: string[];
  llm: LLMProvider | null;
  vision: VisionProvider | null;
  embedding: EmbeddingProvider | null;
  decision: DecisionProvider | null;
  meta: AiRuntimeMeta;
}

export interface SelectAiRuntimeOptions {
  /**
   * Explicit opt-in for the deterministic fake outside development/test.
   * Mirrors discovery's `allowFake`: production requires this to be true.
   */
  allowFake?: boolean | undefined;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Optional Jev/DecisionProvider plug-in — never required. */
  decision?: DecisionProvider | undefined;
}

function notConfigured(reason: string, missing: string[], meta: AiRuntimeMeta): AiRuntime {
  return { status: 'NOT_CONFIGURED', reason, missing, llm: null, vision: null, embedding: null, decision: null, meta };
}

/** Chooses the AI runtime from validated configuration. No network I/O here. */
export function selectAiRuntime(
  config: AiConfig,
  options: SelectAiRuntimeOptions = {},
): AiRuntime {
  const providerName = providerNameFor(config);
  const baseMeta = {
    provider: providerName,
    modelVersion: config.AI_MODEL ?? 'unconfigured',
    promptVersion: config.AI_PROMPT_VERSION,
    schemaVersion: config.AI_SCHEMA_VERSION,
  };

  if (config.AI_PROVIDER === 'none') {
    return notConfigured('AI_PROVIDER=none (AI execution disabled by configuration)', [], {
      ...baseMeta,
      kind: 'NONE',
      provider: 'none',
    });
  }

  if (config.AI_PROVIDER === 'fake') {
    const inProduction = config.NODE_ENV === 'production';
    if (inProduction && options.allowFake !== true) {
      return notConfigured(
        'deterministic fake AI provider refused: set an explicit allowFake opt-in (production never selects a fake silently)',
        [],
        { ...baseMeta, kind: 'FAKE' },
      );
    }
    const llm = new DeterministicFakeLlmProvider(providerName, 'fake-1');
    // Phase 18: the fake runtime ALSO carries the deterministic fake vision
    // slot so local E2E can exercise the multimodal path without credentials.
    const vision = new DeterministicFakeVisionProvider(`${providerName}:vision`, 'fake-vision-1');
    return {
      status: 'READY',
      missing: [],
      llm,
      vision,
      embedding: null,
      decision: options.decision ?? null,
      meta: { ...baseMeta, kind: 'FAKE', modelVersion: 'fake-1' },
    };
  }

  // AI_PROVIDER=http
  const missing = missingCredentials(config);
  if (missing.length > 0) {
    return notConfigured(
      `OpenAI-compatible HTTP provider is not configured (missing ${missing.join(', ')})`,
      missing,
      { ...baseMeta, kind: 'HTTP' },
    );
  }

  const shared = {
    baseUrl: config.AI_BASE_URL as string,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL as string,
    timeoutMs: config.AI_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
    backoffMs: config.AI_RETRY_BACKOFF_MS,
    promptVersion: config.AI_PROMPT_VERSION,
    schemaVersion: config.AI_SCHEMA_VERSION,
    providerName,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  };

  const llm: LLMProvider = new HttpLlmProvider(shared);
  const vision: VisionProvider | null =
    config.AI_VISION_MODEL !== undefined
      ? new HttpVisionProvider({ ...shared, model: config.AI_VISION_MODEL, providerName: `${providerName}:vision` })
      : null;
  const embedding: EmbeddingProvider | null =
    config.AI_EMBEDDING_MODEL !== undefined
      ? new HttpEmbeddingProvider({ ...shared, model: config.AI_EMBEDDING_MODEL, providerName: `${providerName}:embedding` })
      : null;

  return {
    status: 'READY',
    missing: [],
    llm,
    vision,
    embedding,
    decision: options.decision ?? null,
    meta: { ...baseMeta, kind: 'HTTP' },
  };
}

/** Convenience: load config from env and select in one call. */
export function selectAiRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: SelectAiRuntimeOptions = {},
): AiRuntime {
  return selectAiRuntime(loadAiConfig(env), options);
}

/** Throws a typed NOT_CONFIGURED error instead of returning null. */
export function requireLlm(runtime: AiRuntime): LLMProvider {
  if (runtime.status !== 'READY' || runtime.llm === null) {
    throw new AiNotConfiguredError(
      runtime.meta.provider,
      runtime.missing.length > 0 ? runtime.missing : [runtime.reason ?? 'AI runtime not ready'],
    );
  }
  return runtime.llm;
}

/** Typed refusal used when a fake must not run (defence in depth). */
export function refuseFakeInProduction(runtime: AiRuntime): void {
  if (runtime.meta.kind === 'FAKE') {
    throw new AiUnavailableError(runtime.meta.provider, 'deterministic fake provider is not allowed here');
  }
}
