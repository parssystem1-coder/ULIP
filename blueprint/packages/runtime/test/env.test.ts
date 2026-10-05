import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadEnv, EnvValidationError } from '../src/env.ts';

const VALID = {
  AUTH_SECRET: 'a-super-secret-value-16+',
  BOOTSTRAP_API_KEY: 'bootstrap-key-16+chars',
};

test('valid env parses with defaults', () => {
  const env = loadEnv({ ...VALID } as unknown as NodeJS.ProcessEnv);
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.APP_PORT, 3001);
  assert.ok(env.DATABASE_URL.startsWith('postgresql://'));
});

test('missing AUTH_SECRET fails fast with a clear issue list', () => {
  assert.throws(() => loadEnv({} as unknown as NodeJS.ProcessEnv), (err: unknown) => {
    assert.ok(err instanceof EnvValidationError);
    return err.issues.some((i) => i.includes('AUTH_SECRET'));
  });
});

test('short AUTH_SECRET is rejected', () => {
  assert.throws(
    () => loadEnv({ ...VALID, AUTH_SECRET: 'short' } as unknown as NodeJS.ProcessEnv),
    EnvValidationError,
  );
});
