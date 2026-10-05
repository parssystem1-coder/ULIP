import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Router } from '../src/middleware.ts';

test('router matches static and parameterized routes per method', () => {
  const router = new Router();
  const a = (): void => undefined;
  const b = (): void => undefined;
  const c = (): void => undefined;
  router.add('GET', '/leads', a);
  router.add('GET', '/jobs/:jobId', b);
  router.add('POST', '/leads', c);

  assert.equal(router.match('GET', '/leads')?.handler, a);
  assert.equal(router.match('POST', '/leads')?.handler, c);
  const job = router.match('GET', '/jobs/123e4567-e89b-12d3-a456-426614174000');
  assert.equal(job?.handler, b);
  assert.equal(job?.params['jobId'], '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(router.match('DELETE', '/leads'), null);
  assert.equal(router.match('GET', '/nope'), null);
  assert.equal(router.match('GET', '/jobs'), null); // wrong segment count
});

test('router decodes path parameters', () => {
  const router = new Router();
  router.add('GET', '/jobs/:jobId', () => undefined);
  const m = router.match('GET', '/jobs/hello%20world');
  assert.equal(m?.params['jobId'], 'hello world');
});
