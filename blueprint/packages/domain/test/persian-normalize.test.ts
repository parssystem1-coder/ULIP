import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  unifyPersianCharacters,
  normalizePersian,
  aliasKey,
  guessLocale,
} from '../src/persian-normalize.ts';

test('unifies Arabic yeh/kaf to Persian forms', () => {
  assert.equal(unifyPersianCharacters('\u0643\u062A\u0627\u0628 \u064A'), '\u06A9\u062A\u0627\u0628 \u06CC');
});

test('maps Persian and Arabic digits to ASCII', () => {
  assert.equal(unifyPersianCharacters('\u06F0\u06F1\u06F2\u06F3'), '0123');
  assert.equal(unifyPersianCharacters('\u0664\u0665'), '45');
});

test('normalization is idempotent and casefolds Latin', () => {
  const once = normalizePersian('Beauty Salon');
  assert.equal(once, 'beauty salon');
  assert.equal(normalizePersian(once), once);
});

test('preserves in-word ZWNJ and drops standalone ZWNJ', () => {
  // نیم‌فاصله: ZWNJ inside the word must survive
  const word = '\u0646\u06CC\u0645\u200C\u0641\u0627\u0635\u0644\u0647';
  assert.ok(normalizePersian(word).includes('\u200C'));
  // standalone ZWNJ next to a Latin token is dropped
  assert.equal(normalizePersian('foo\u200C bar'), 'foo bar');
});

test('aliasKey collides ZWNJ variants and Arabic spellings', () => {
  // 'نیم فاصله' (space) vs 'نیم‌فاصله' (ZWNJ) must produce the same key
  const withZwnj = aliasKey('\u0646\u06CC\u0645\u200C\u0641\u0627\u0635\u0644\u0647');
  const withSpace = aliasKey('\u0646\u06CC\u0645 \u0641\u0627\u0635\u0644\u0647');
  assert.equal(withZwnj, withSpace);
  // Arabic kaf vs Persian kaf collide ('مكتب' vs 'مکتب')
  assert.equal(aliasKey('\u0645\u0643\u062A\u0628'), aliasKey('\u0645\u06A9\u062A\u0628'));
});

test('aliasKey for the canonical salon aliases matches seed data shape', () => {
  // 'آرایشگاه زنانه' already uses Persian yeh; normalization leaves it unchanged,
  // so the seed's alias_norm and aliasKey() must produce the identical string.
  assert.equal(aliasKey('\u0622\u0631\u0627\u06CC\u0634\u06AF\u0627\u0647 \u0632\u0646\u0627\u0646\u0647'), '\u0622\u0631\u0627\u06CC\u0634\u06AF\u0627\u0647 \u0632\u0646\u0627\u0646\u0647');
});

test('guessLocale detects Persian vs Latin', () => {
  assert.equal(guessLocale('\u0634\u06CC\u0631\u0627\u0632'), 'fa');
  assert.equal(guessLocale('Shiraz'), 'en');
});
