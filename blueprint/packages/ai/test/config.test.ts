import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AiConfigError, loadAiConfig, missingCredentials, selectAiRuntime } from '../src/index.ts';

const FULL = {
  AI_BASE_URL: 'https://llm.example.com/v1',
  AI_API_KEY: 'sk-test',
  AI_MODEL: 'test-model',
};

test('valid HTTP configuration loads and selects a READY runtime', () => {
  const cfg = loadAiConfig({ ...FULL, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  assert.equal(cfg.AI_PROVIDER, 'http');
  assert.equal(cfg.AI_TIMEOUT_MS, 30000);
  assert.equal(missingCredentials(cfg).length, 0);
  const runtime = selectAiRuntime(cfg);
  assert.equal(runtime.status, 'READY');
  assert.equal(runtime.meta.kind, 'HTTP');
  assert.ok(runtime.llm !== null);
  assert.equal(runtime.vision, null);
  assert.equal(runtime.embedding, null);
  assert.equal(runtime.decision, null); // Jev stays optional (ADR-017)
});

test('malformed values fail fast with AiConfigError', () => {
  assert.throws(() => loadAiConfig({ AI_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv), AiConfigError);
  assert.throws(() => loadAiConfig({ AI_TIMEOUT_MS: '5' } as NodeJS.ProcessEnv), AiConfigError);
  assert.throws(() => loadAiConfig({ AI_PROVIDER: 'openai' } as NodeJS.ProcessEnv), AiConfigError);
  assert.throws(
    () =>
      loadAiConfig({
        AI_BASE_URL: 'http://llm.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'm',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
    /https/,
  );
});

test('well-formed but incomplete configuration reports NOT_CONFIGURED', () => {
  const cfg = loadAiConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
  const missing = missingCredentials(cfg);
  assert.deepEqual(missing, ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY']);
  const runtime = selectAiRuntime(cfg);
  assert.equal(runtime.status, 'NOT_CONFIGURED');
  assert.equal(runtime.llm, null);
  assert.ok((runtime.reason ?? '').includes('not configured'));
  assert.deepEqual(runtime.missing, missing);
});

test('AI_PROVIDER=none is an explicit NOT_CONFIGURED state', () => {
  const cfg = loadAiConfig({ AI_PROVIDER: 'none' } as NodeJS.ProcessEnv);
  const runtime = selectAiRuntime(cfg);
  assert.equal(runtime.status, 'NOT_CONFIGURED');
  assert.equal(runtime.meta.kind, 'NONE');
});

test('fake provider is refused in production unless explicitly allowed', () => {
  const cfg = loadAiConfig({ AI_PROVIDER: 'fake', NODE_ENV: 'production' } as NodeJS.ProcessEnv);
  const refused = selectAiRuntime(cfg);
  assert.equal(refused.status, 'NOT_CONFIGURED');
  assert.ok((refused.reason ?? '').includes('fake'));

  const allowed = selectAiRuntime(cfg, { allowFake: true });
  assert.equal(allowed.status, 'READY');
  assert.equal(allowed.meta.kind, 'FAKE');
});

test('fake provider is available in development/test when explicitly configured', () => {
  const cfg = loadAiConfig({ AI_PROVIDER: 'fake', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const runtime = selectAiRuntime(cfg);
  assert.equal(runtime.status, 'READY');
  assert.equal(runtime.meta.kind, 'FAKE');
});

test('no fake is selected when another provider is configured', () => {
  const cfg = loadAiConfig({ ...FULL, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
  const runtime = selectAiRuntime(cfg);
  assert.notEqual(runtime.meta.kind, 'FAKE');
});
