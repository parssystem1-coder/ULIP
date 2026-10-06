import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AiSchemaValidationError,
  AiTimeoutError,
  HttpLlmProvider,
  type FetchLike,
} from '../src/index.ts';

const VALID_PROFILE = {
  businessType: { value: 'Wholesaler', confidence: 0.9, evidenceIds: ['e1'], availability: 'AVAILABLE' },
  specialties: [{ value: 'Printer Parts', confidence: 0.8, evidenceIds: ['e1'], availability: 'AVAILABLE' }],
  city: { value: 'Tehran', confidence: 0.85, evidenceIds: ['e1'], availability: 'AVAILABLE', provenance: 'EXPLICIT' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chat(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function makeProvider(fetchImpl: FetchLike, maxRetries = 2): HttpLlmProvider {
  return new HttpLlmProvider({
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'sk-secret',
    model: 'test-model',
    timeoutMs: 500,
    maxRetries,
    backoffMs: 0,
    promptVersion: 'p1',
    schemaVersion: '1',
    providerName: 'http:llm.example.com',
    fetchImpl,
    sleep: async () => undefined,
  });
}

const INPUT = {
  profileText: 'HP printer parts wholesaler',
  locationHints: [],
  contentSamples: [{ contentId: 'e1', text: 'HP printer parts wholesaler Tehran' }],
  taxonomySnapshot: [{ nodeId: 'n1', label: 'Wholesaler', nodeKind: 'BUSINESS_TYPE' as const }],
  locale: 'en',
};

test('calls the configured OpenAI-compatible endpoint and parses the profile', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return chat(JSON.stringify(VALID_PROFILE));
  };
  const provider = makeProvider(fetchImpl);
  const result = await provider.extractStructuredProfile(INPUT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://llm.example.com/v1/chat/completions');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer sk-secret');
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body['model'], 'test-model');
  assert.equal(result.profile.businessType?.value, 'Wholesaler');
  assert.equal(result.meta.provider, 'http:llm.example.com');
  assert.equal(result.meta.modelVersion, 'test-model');
});

test('non-JSON answer triggers one bounded repair attempt', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return calls === 1 ? chat('not json at all') : chat(JSON.stringify(VALID_PROFILE));
  };
  const result = await makeProvider(fetchImpl).extractStructuredProfile(INPUT);
  assert.equal(calls, 2);
  assert.equal(result.profile.businessType?.value, 'Wholesaler');
});

test('persistently invalid output fails with a contract error', async () => {
  let calls = 0;
  const bad = { businessType: { value: 'Wholesaler', confidence: 7, evidenceIds: ['nope'] } };
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return chat(JSON.stringify(bad));
  };
  await assert.rejects(
    () => makeProvider(fetchImpl).extractStructuredProfile(INPUT),
    AiSchemaValidationError,
  );
  assert.equal(calls, 2); // bounded repair, then fail
});

test('a 400 about response_format retries once without it', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: { message: 'response_format is not supported' } }, 400)
      : chat(JSON.stringify(VALID_PROFILE));
  };
  const result = await makeProvider(fetchImpl).extractStructuredProfile(INPUT);
  assert.equal(calls, 2);
  assert.ok('response_format' in (bodies[0] ?? {}));
  assert.equal('response_format' in (bodies[1] ?? {}), false);
  assert.equal(result.profile.city?.value, 'Tehran');
});

test('5xx responses are retried with backoff', async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return calls < 3 ? jsonResponse({ error: 'boom' }, 503) : chat(JSON.stringify(VALID_PROFILE));
  };
  const result = await makeProvider(fetchImpl, 3).extractStructuredProfile(INPUT);
  assert.equal(calls, 3);
  assert.ok(result.profile.businessType !== undefined);
});

test('timeouts surface as AiTimeoutError', async () => {
  const fetchImpl: FetchLike = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const provider = new HttpLlmProvider({
    baseUrl: 'https://llm.example.com/v1',
    model: 'm',
    timeoutMs: 50,
    maxRetries: 0,
    backoffMs: 0,
    promptVersion: 'p1',
    schemaVersion: '1',
    providerName: 'http:llm.example.com',
    fetchImpl,
    sleep: async () => undefined,
  });
  await assert.rejects(() => provider.extractStructuredProfile(INPUT), AiTimeoutError);
});

test('query parsing yields typed filters, never SQL or unknown keys', async () => {
  const payload = {
    filters: { city: 'Tehran', businessTypes: ['Wholesaler'], minRelevance: 70, dropTable: 'x' },
    confidence: 0.8,
    unmatchedTerms: ['please'],
  };
  const provider = makeProvider(async () => chat(JSON.stringify(payload)));
  const parsed = await provider.parseSearchQuery({ text: 'wholesalers in Tehran', locale: 'en' });
  assert.equal(parsed.filters.city, 'Tehran');
  assert.deepEqual(parsed.filters.businessTypes, ['Wholesaler']);
  assert.equal(parsed.filters.minRelevance, 70);
  assert.equal((parsed.filters as Record<string, unknown>)['dropTable'], undefined);
  assert.equal(parsed.confidence, 0.8);
  assert.deepEqual(parsed.unmatchedTerms, ['please']);
});
