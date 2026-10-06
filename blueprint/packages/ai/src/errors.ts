/**
 * Typed AI runtime errors (Phase 16).
 *
 * Every error carries an orchestration ErrorCode subset so the worker can map
 * failures through FAILURE_POLICY (ADR-016) without string matching:
 *
 *  NOT_CONFIGURED          → no credentials; never fabricate a provider
 *  AI_PROVIDER_ERROR       → provider answered with an error (fallback path)
 *  TIMEOUT                 → provider did not answer in time (retry path)
 *  RATE_LIMITED            → provider asked us to slow down (retry path)
 *  SCHEMA_VALIDATION_ERROR → provider output violated the task contract
 *  AI_UNAVAILABLE          → runtime refused to execute (fake in production)
 *
 * These strings are a SUBSET of ErrorCode in @ulip/orchestration.
 */

export type AiErrorCode =
  | 'NOT_CONFIGURED'
  | 'AI_PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SCHEMA_VALIDATION_ERROR'
  | 'AI_UNAVAILABLE';

export interface AiErrorOptions {
  provider: string;
  retryable?: boolean;
  details?: string[];
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly details: string[];

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }
}

/** No (or incomplete) provider credentials — production returns this honestly. */
export class AiNotConfiguredError extends AiError {
  readonly missing: string[];

  constructor(provider: string, missing: string[]) {
    super(
      'NOT_CONFIGURED',
      `AI provider NOT_CONFIGURED: missing ${missing.join(', ')}`,
      { provider, retryable: false, details: missing },
    );
    this.name = 'AiNotConfiguredError';
    this.missing = missing;
  }
}

/** The runtime refuses to execute (e.g. deterministic fake in production). */
export class AiUnavailableError extends AiError {
  constructor(provider: string, reason: string) {
    super('AI_UNAVAILABLE', `AI provider unavailable: ${reason}`, {
      provider,
      retryable: false,
      details: [reason],
    });
    this.name = 'AiUnavailableError';
  }
}

/** Network / HTTP failure from a configured provider. */
export class AiProviderError extends AiError {
  readonly status?: number | undefined;

  constructor(provider: string, message: string, opts: { status?: number | undefined; retryable?: boolean } = {}) {
    super('AI_PROVIDER_ERROR', message, {
      provider,
      retryable: opts.retryable ?? true,
      ...(opts.status !== undefined ? { details: [`http ${opts.status}`] } : {}),
    });
    this.name = 'AiProviderError';
    this.status = opts.status;
  }
}

/** Provider exceeded the configured timeout. */
export class AiTimeoutError extends AiError {
  constructor(provider: string, timeoutMs: number) {
    super('TIMEOUT', `AI provider timed out after ${timeoutMs}ms`, {
      provider,
      retryable: true,
    });
    this.name = 'AiTimeoutError';
  }
}

/** Provider answered 429. */
export class AiRateLimitError extends AiError {
  constructor(provider: string, retryAfterSeconds?: number | undefined) {
    super('RATE_LIMITED', `AI provider rate limited${retryAfterSeconds !== undefined ? ` (retry after ${retryAfterSeconds}s)` : ''}`, {
      provider,
      retryable: true,
    });
    this.name = 'AiRateLimitError';
  }
}

/** Provider output violated the task contract (ADR-008 evidence-first rules). */
export class AiSchemaValidationError extends AiError {
  constructor(provider: string, errors: string[]) {
    super(
      'SCHEMA_VALIDATION_ERROR',
      `AI output failed contract validation: ${errors.join('; ')}`,
      { provider, retryable: true, details: errors },
    );
    this.name = 'AiSchemaValidationError';
  }
}

/** Narrowing helper: is this error retryable per its typed code? */
export function isRetryableAiError(err: unknown): boolean {
  return err instanceof AiError && err.retryable;
}
