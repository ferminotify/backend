import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signupKeywordList, signupKeywords } from '../utils/timetable/match.js';

const index = readFileSync(new URL('./fixtures/timetable/index.html', import.meta.url), 'utf8');

test('signup keyword: school site down, kept as written', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await signupKeywords('5elee'), ['5ELEE']);
});

test('signup keyword: classes with their joint classes, surnames, unknown classes as written', async () => {
  globalThis.fetch = async () => new Response(index);
  assert.deepEqual(await signupKeywords(undefined), []);
  assert.deepEqual(await signupKeywords('  '), []);
  assert.deepEqual(await signupKeywords('1 a'), ['1A']);
  assert.deepEqual(await signupKeywords('5eele'), ['5EELE', '5EELEET']);
  assert.deepEqual(await signupKeywords('5EELEET'), ['5EELEET']);
  assert.deepEqual(await signupKeywords('del  modello'), ['DEL MODELLO']);
  assert.deepEqual(await signupKeywords('5ELEE'), ['5ELEE']);
  assert.deepEqual(await signupKeywords('li'), ['LI']);
  assert.equal(await signupKeywords('a'), null);
  assert.equal(await signupKeywords('...'), null);
  assert.deepEqual(await signupKeywords({ a: 1 }), []);
});

test('signup keywords: a list (or the older single keyword), merged, at most 5', async () => {
  globalThis.fetch = async () => new Response(index);
  assert.deepEqual(await signupKeywordList(['5eele', 'rossi', '5EELEET', 'Rossi']), ['5EELE', '5EELEET', 'ROSSI']);
  assert.deepEqual(await signupKeywordList('1a'), ['1A']);
  assert.deepEqual(await signupKeywordList(undefined), []);
  assert.equal(await signupKeywordList(['1A', 'a']), null);
  assert.equal((await signupKeywordList(Array.from({ length: 8 }, (_, i) => `PIPPO${'X'.repeat(i)}`))).length, 5);
});
