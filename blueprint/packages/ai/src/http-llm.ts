/**
 * Configurable HTTP LLM adapter (Phase 16).
 *
 * Speaks the OpenAI-compatible Chat Completions shape against whatever base
 * URL the operator configures — no vendor is hard-coded, and the ULIP
 * `LLMProvider` contract is preserved on the inside. Output is validated
 * against the task contract with bounded repair (2 attempts max) before a
 * result is ever returned.
 */

import type {
  AiMetadata,
  ExtractionResult,
  LLMProvider,
  ParsedSearchQuery,
  ProfileExtractionInput,
  StructuredProfile,
} from './interfaces.ts';
import type { LeadSearchFilters, LeadStatus } from '@ulip/domain/contracts';
import { AiSchemaValidationError } from './errors.ts';
import { chatContent, extractJson, joinUrl, postJson, type FetchLike } from './http.ts';
import {
  parseExtractionProfile,
  taxonomySnapshotBlock,
  validateExtractionOutput,
} from './validation.ts';

export interface HttpLlmOptions {
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

const SYSTEM_PROMPT = `You are the ULIP structured profile extraction service.
You convert observed lead evidence into the ULIP universal business model.

Output ONLY a single JSON object with this shape (no prose, no markdown):
{
  "businessType":   { "value": string, "confidence": number, "evidenceIds": string[], "availability": "AVAILABLE"|"PARTIAL"|"INFERRED"|"UNAVAILABLE" },
  "industry":       { ... same ... },
  "specialties":    [ { ... same ... } ],
  "brands":         [ { ... same ... } ],
  "city":           { ... same ..., "provenance": "EXPLICIT"|"INFERRED"|"UNKNOWN" }
}

Hard rules:
1. EVIDENCE-FIRST: every claim MUST cite evidenceIds taken ONLY from the
   provided evidence samples. If no sample supports a field, OMIT the field.
   Never invent facts, names, locations or brands.
2. "value" should be a taxonomy nodeId from the provided snapshot when a node
   matches the observed business model; otherwise a short canonical label.
3. confidence is a number in [0,1]; be conservative: explicit statements are
   0.85-0.95, inferences are <= 0.7.
4. availability: AVAILABLE = stated explicitly, PARTIAL = partially supported,
   INFERRED = derived, UNAVAILABLE = not present (then omit the field).
5. Do not output chain-of-thought, explanations, SQL or code.`;

const QUERY_SYSTEM_PROMPT = `You convert a user's search text into the ULIP structured
search filter object. Output ONLY JSON:
{ "filters": { ... }, "confidence": number, "unmatchedTerms": string[] }
Allowed filter keys: businessTypes, industries, specialties, subSpecialties,
brands, city, country, sourceType, status, minRelevance, minAudienceQuality,
minActivity, minConfidence.
List keys take arrays of strings; city/country/sourceType/status take a string;
min* keys take a number 0..100. Terms you cannot map go to unmatchedTerms.
Never output SQL or arbitrary expressions.`;

const SUMMARY_SYSTEM_PROMPT = `Summarize the input text for a lead record.
Output ONLY JSON: { "summary": string } where summary has at most the requested
number of short bullet points separated by newlines starting with "- ".
Facts only; never invent information.`;

const SEARCH_LIST_KEYS = [
  'businessTypes',
  'industries',
  'specialties',
  'subSpecialties',
  'brands',
] as const;
const SEARCH_NUMBER_KEYS = ['minRelevance', 'minAudienceQuality', 'minActivity', 'minConfidence'] as const;
const SEARCH_STRING_KEYS = ['city', 'country', 'sourceType'] as const;
const LEAD_STATUSES: readonly string[] = [
  'DISCOVERED', 'RAW_STORED', 'NORMALIZED', 'DEDUP_CHECKED', 'ANALYSIS_PENDING',
  'ANALYZING', 'SCORED', 'REVIEW_REQUIRED', 'QUALIFIED', 'REJECTED', 'FAILED', 'ARCHIVED',
];

export class HttpLlmProvider implements LLMProvider {
  private readonly options: HttpLlmOptions;

  constructor(options: HttpLlmOptions) {
    this.options = options;
  }

  /** Metadata stamped on every result / ai_runs row. */
  metadata(): AiMetadata {
    return {
      provider: this.options.providerName,
      modelVersion: this.options.model,
      promptVersion: this.options.promptVersion,
      schemaVersion: this.options.schemaVersion,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey !== undefined && this.options.apiKey !== '') {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }
    return headers;
  }

  private async complete(system: string, user: string): Promise<{ text: string; latencyMs: number }> {
    const url = joinUrl(this.options.baseUrl, '/chat/completions');
    const body: Record<string, unknown> = {
      model: this.options.model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };
    const result = await postJson<unknown>({
      url,
      headers: this.headers(),
      body,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      backoffMs: this.options.backoffMs,
      provider: this.options.providerName,
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
      sanitizeBody: (b, err) =>
        err.message.includes('response_format') && 'response_format' in b
          ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'response_format'))
          : null,
    });
    return { text: chatContent(result.data), latencyMs: result.latencyMs };
  }

  private async completeJson(
    system: string,
    user: string,
    validate: (raw: unknown) => { ok: boolean; errors: string[] },
  ): Promise<unknown> {
    let lastErrors: string[] = [];
    let prompt = user;
    const attempts = Math.max(1, Math.min(2, this.options.maxRetries + 1));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { text } = await this.complete(system, prompt);
      let raw: unknown;
      try {
        raw = JSON.parse(extractJson(text));
      } catch {
        lastErrors = ['response was not valid JSON'];
      }
      if (raw !== undefined) {
        const verdict = validate(raw);
        if (verdict.ok) return raw;
        lastErrors = verdict.errors;
      }
      // Bounded repair: send the contract violations back exactly once.
      prompt = `${user}\n\nYour previous answer was rejected by contract validation:\n- ${lastErrors.join(
        '\n- ',
      )}\nReturn ONLY the corrected JSON object.`;
    }
    throw new AiSchemaValidationError(this.options.providerName, lastErrors);
  }

  async extractStructuredProfile(input: ProfileExtractionInput): Promise<ExtractionResult> {
    const user = JSON.stringify({
      taxonomySnapshot: input.taxonomySnapshot,
      taxonomySnapshotText: taxonomySnapshotBlock(input.taxonomySnapshot),
      profileText: input.profileText ?? '',
      locationHints: input.locationHints ?? [],
      locale: input.locale ?? 'fa',
      evidenceSamples: input.contentSamples.map((s) => ({
        id: s.contentId,
        text: s.text ?? '',
        publishedAt: s.publishedAt ?? null,
      })),
    });
    const raw = await this.completeJson(
      SYSTEM_PROMPT,
      user,
      (out) => validateExtractionOutput(input, out),
    );
    const profile: StructuredProfile = parseExtractionProfile(raw);
    return { profile, meta: this.metadata() };
  }

  async parseSearchQuery(input: { text: string; locale: string }): Promise<ParsedSearchQuery> {
    const raw = await this.completeJson(
      QUERY_SYSTEM_PROMPT,
      JSON.stringify({ text: input.text, locale: input.locale }),
      (out) => {
        if (typeof out !== 'object' || out === null || Array.isArray(out)) {
          return { ok: false, errors: ['output must be a JSON object'] };
        }
        const filters = (out as Record<string, unknown>)['filters'];
        if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
          return { ok: false, errors: ['filters must be an object'] };
        }
        const confidence = (out as Record<string, unknown>)['confidence'];
        if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          return { ok: false, errors: ['confidence must be a number in [0,1]'] };
        }
        return { ok: true, errors: [] };
      },
    );
    const r = raw as Record<string, unknown>;
    const { filters, unmatched } = normalizeFilters(
      (r['filters'] ?? {}) as Record<string, unknown>,
      Array.isArray(r['unmatchedTerms']) ? (r['unmatchedTerms'] as unknown[]) : [],
    );
    return {
      filters,
      confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0,
      unmatchedTerms: unmatched,
      meta: this.metadata(),
    };
  }

  async summarize(input: { text: string; maxPoints: number }): Promise<{ summary: string; meta: AiMetadata }> {
    const raw = await this.completeJson(
      SUMMARY_SYSTEM_PROMPT,
      JSON.stringify({ text: input.text.slice(0, 8000), maxPoints: input.maxPoints }),
      (out) =>
        typeof out === 'object' && out !== null && typeof (out as Record<string, unknown>)['summary'] === 'string'
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['summary must be a string'] },
    );
    const summary = String((raw as Record<string, unknown>)['summary']).trim();
    const points = summary.split('\n').slice(0, Math.max(1, input.maxPoints));
    return { summary: points.join('\n'), meta: this.metadata() };
  }
}

/** Coerces provider filters into the typed LeadSearchFilters shape (no SQL). */
export function normalizeFilters(
  raw: Record<string, unknown>,
  unmatchedTerms: unknown[],
): { filters: LeadSearchFilters; unmatched: string[] } {
  const filters: LeadSearchFilters = {};
  const unmatched = unmatchedTerms.filter((t): t is string => typeof t === 'string');

  for (const key of SEARCH_LIST_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    const arr = Array.isArray(v) ? v : [v];
    const strings = arr.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (strings.length === 0) {
      unmatched.push(key);
      continue;
    }
    filters[key] = strings;
  }
  for (const key of SEARCH_STRING_KEYS) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim() !== '') filters[key] = v.trim();
    else if (v !== undefined && v !== null) unmatched.push(key);
  }
  if (typeof raw['status'] === 'string' && LEAD_STATUSES.includes(raw['status'])) {
    filters['status'] = raw['status'] as LeadStatus;
  } else if (raw['status'] !== undefined) {
    unmatched.push('status');
  }
  for (const key of SEARCH_NUMBER_KEYS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) filters[key] = v;
    else if (v !== undefined) unmatched.push(key);
  }
  return { filters, unmatched };
}
