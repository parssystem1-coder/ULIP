/**
 * Optional OpenAI-compatible adapters for the VISION and EMBEDDING slots
 * (Phase 16). Both are OPTIONAL: when their model is not configured the
 * runtime slot stays `null` and callers treat vision/embeddings as
 * unavailable — never as silently working.
 *
 * Vision observations are returned with empty `evidenceIds` on purpose: only
 * the analysis runtime can bind an observation to persisted evidence
 * (evidence-first, ADR-008). An unbound observation is uncertain by design.
 */

import type { AiMetadata, EmbeddingProvider, VisionProvider, VisualAnalysis } from './interfaces.ts';
import { AiSchemaValidationError } from './errors.ts';
import { chatContent, extractJson, joinUrl, postJson, type FetchLike } from './http.ts';

interface SlotOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  promptVersion: string;
  schemaVersion: string;
  providerName: string;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

function headersFor(options: SlotOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey !== undefined && options.apiKey !== '') {
    headers['authorization'] = `Bearer ${options.apiKey}`;
  }
  return headers;
}

export class HttpVisionProvider implements VisionProvider {
  private readonly options: SlotOptions;

  constructor(options: SlotOptions) {
    this.options = options;
  }

  metadata(): AiMetadata {
    return {
      provider: this.options.providerName,
      modelVersion: this.options.model,
      promptVersion: this.options.promptVersion,
      schemaVersion: this.options.schemaVersion,
    };
  }

  async analyzeImage(input: { uri: string; context?: string }): Promise<VisualAnalysis> {
    const url = joinUrl(this.options.baseUrl, '/chat/completions');
    const result = await postJson<unknown>({
      url,
      headers: headersFor(this.options),
      body: {
        model: this.options.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You describe observable content only. Output ONLY JSON: ' +
              '{"observations":[{"label":string,"confidence":number}]} where confidence is in [0,1]. ' +
              'Never claim identity, ownership or intent beyond what is visible.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: input.context ?? 'Describe the observable business signals.' },
              { type: 'image_url', image_url: { url: input.uri } },
            ],
          },
        ],
      },
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      backoffMs: this.options.backoffMs,
      provider: this.options.providerName,
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
    });

    let raw: unknown;
    try {
      raw = JSON.parse(extractJson(chatContent(result.data)));
    } catch {
      throw new AiSchemaValidationError(this.options.providerName, ['vision response was not valid JSON']);
    }
    const observationsRaw = (raw as Record<string, unknown>)?.['observations'];
    if (!Array.isArray(observationsRaw)) {
      throw new AiSchemaValidationError(this.options.providerName, ['observations must be an array']);
    }
    const observations = observationsRaw
      .map((o) => {
        const rec = o as Record<string, unknown>;
        const label = typeof rec['label'] === 'string' ? rec['label'] : '';
        const confidence = typeof rec['confidence'] === 'number' ? rec['confidence'] : Number.NaN;
        return { label, confidence, evidenceIds: [] as string[] };
      })
      .filter(
        (o) =>
          o.label !== '' &&
          Number.isFinite(o.confidence) &&
          o.confidence >= 0 &&
          o.confidence <= 1,
      );
    if (observations.length === 0) {
      throw new AiSchemaValidationError(this.options.providerName, ['no valid observations returned']);
    }
    return { observations, meta: this.metadata() };
  }

  async analyzeImages(input: { uris: string[]; context?: string }): Promise<VisualAnalysis[]> {
    const out: VisualAnalysis[] = [];
    for (const uri of input.uris) {
      out.push(await this.analyzeImage({ uri, ...(input.context !== undefined ? { context: input.context } : {}) }));
    }
    return out;
  }
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly options: SlotOptions;

  constructor(options: SlotOptions) {
    this.options = options;
  }

  metadata(): AiMetadata {
    return {
      provider: this.options.providerName,
      modelVersion: this.options.model,
      promptVersion: this.options.promptVersion,
      schemaVersion: this.options.schemaVersion,
    };
  }

  async embed(input: { text: string }): Promise<{ vector: number[]; meta: AiMetadata }> {
    const url = joinUrl(this.options.baseUrl, '/embeddings');
    const result = await postJson<{ data?: { embedding?: unknown }[] }>({
      url,
      headers: headersFor(this.options),
      body: { model: this.options.model, input: input.text },
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      backoffMs: this.options.backoffMs,
      provider: this.options.providerName,
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
    });
    const payload = result.data;
    const raw = payload.data?.[0]?.embedding;
    if (!Array.isArray(raw) || raw.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new AiSchemaValidationError(this.options.providerName, ['embedding must be a finite number array']);
    }
    return { vector: raw as number[], meta: this.metadata() };
  }
}
