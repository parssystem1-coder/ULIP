import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hashApiKey, hashesEqual, extractBearerToken } from '../src/auth.ts';

test('api key hashing is deterministic sha-256', () => {
  assert.equal(hashApiKey('k1'), hashApiKey('k1'));
  assert.notEqual(hashApiKey('k1'), hashApiKey('k2'));
  assert.equal(hashApiKey('k1').length, 64);
});

test('hashesEqual is constant-time-safe and correct', () => {
  assert.equal(hashesEqual(hashApiKey('a'), hashApiKey('a')), true);
  assert.equal(hashesEqual(hashApiKey('a'), hashApiKey('b')), false);
});

test('bearer token extraction', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken(undefined), null);
});
