/**
 * Shared HTTP transport for OpenAI-compatible providers (Phase 16).
 *
 * Vendor-neutral: only the configured base URL is ever contacted. The helper
 * is injectable (`fetchImpl`, `sleep`) so tests run without a network.
 *
 * Retry policy: network errors, timeouts, 408, 429 and 5xx are retried with
 * exponential backoff (AI_RETRY_BACKOFF_MS base, honoring Retry-After);
 * other 4xx are terminal (AiProviderError, retryable=false).
 */

import { AiProviderError, AiRateLimitError, AiTimeoutError } from './errors.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  provider: string;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Optional escape hatch: when the endpoint rejects a request body field
   * (e.g. `response_format` on some compatible servers) the caller can
   * return a sanitized body to retry once with.
   */
  sanitizeBody?: ((body: Record<string, unknown>, error: Error) => Record<string, unknown> | null) | undefined;
}

export interface PostJsonResult<T> {
  data: T;
  status: number;
  latencyMs: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Joins a base URL with an OpenAI-compatible path (idempotent). */
export function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith(path)) return trimmed;
  return `${trimmed}${path}`;
}

/**
 * POSTs JSON and returns the parsed body. Retries per policy; every failure
 * surfaces as a typed AiError (never a raw fetch error).
 */
export async function postJson<T>(options: PostJsonOptions): Promise<PostJsonResult<T>> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = options.sleep ?? defaultSleep;
  let body = options.body;
  let sanitized = false;

  let attempt = 0;
  for (;;) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: options.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new AiProviderError(
          options.provider,
          `POST ${options.url} failed with ${res.status}: ${text.slice(0, 400)}`,
          { status: res.status, retryable: RETRYABLE_STATUS.has(res.status) },
        );
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw new AiRateLimitError(options.provider, Number.isFinite(retryAfter) ? retryAfter : undefined);
        }
        // One sanitized retry for request-shape rejections (e.g. response_format).
        if (res.status === 400 && !sanitized && options.sanitizeBody !== undefined) {
          const next = options.sanitizeBody(body, err);
          if (next !== null) {
            body = next;
            sanitized = true;
            continue;
          }
        }
        if (!err.retryable || attempt >= options.maxRetries) throw err;
        await sleep(backoffFor(options.backoffMs, attempt));
        attempt += 1;
        continue;
      }

      const json = (await res.json()) as T;
      return { data: json, status: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof AiProviderError || err instanceof AiRateLimitError) {
        if (!err.retryable || attempt >= options.maxRetries) throw err;
        await sleep(backoffFor(options.backoffMs, attempt));
        attempt += 1;
        continue;
      }
      if (isAbort(err)) {
        if (attempt >= options.maxRetries) throw new AiTimeoutError(options.provider, options.timeoutMs);
        await sleep(backoffFor(options.backoffMs, attempt));
        attempt += 1;
        continue;
      }
      if (attempt >= options.maxRetries) {
        throw new AiProviderError(
          options.provider,
          `POST ${options.url} failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        );
      }
      await sleep(backoffFor(options.backoffMs, attempt));
      attempt += 1;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic exponential backoff (documented, no jitter in tests). */
export function backoffFor(baseMs: number, attempt: number): number {
  return baseMs * 2 ** attempt;
}

/** Extracts chat-completion content text from a provider response payload. */
export function chatContent(payload: unknown): string {
  const root = payload as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { text?: unknown };
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('');
  }
  throw new AiProviderError('http', 'provider response missing choices[0].message.content', {
    retryable: false,
  });
}

/** Strips markdown fences and extracts the first JSON object/array. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] !== undefined ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  if (start < 0) return candidate.trim();
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end <= start) return candidate.trim();
  return candidate.slice(start, end + 1).trim();
}
