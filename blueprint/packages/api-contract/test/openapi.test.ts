import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateOpenApi, mustContainSocialPaths } from '../src/validate.ts';

test('OPENAPI.yaml is structurally valid and resolves all $refs', async () => {
  const result = await validateOpenApi();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.valid, true);
});

test('OPENAPI.yaml declares the social actions + outreach API surface', () => {
  const missing = mustContainSocialPaths();
  assert.deepEqual(missing, [], `missing paths: ${missing.join(', ')}`);
});
