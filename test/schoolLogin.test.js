import test from 'node:test';
import assert from 'node:assert/strict';
import { schoolLoginFailed, schoolLoginLimited, schoolLoginSucceeded } from '../utils/limiter.js';

test('school logins: 8 wrong passwords lock the username for a day, a success clears them', () => {
  for (let i = 0; i < 8; i++) schoolLoginFailed('Pippo.Pluto');
  assert.equal(schoolLoginLimited('203.0.113.1', 'pippo.pluto'), true);
  assert.equal(schoolLoginLimited('203.0.113.1', 'paperino.paperone'), false);
  schoolLoginSucceeded('PIPPO.PLUTO');
  assert.equal(schoolLoginLimited('203.0.113.2', 'pippo.pluto'), false);
});

test('school logins: at most 30 a minute overall; attempts blocked per IP do not count', () => {
  for (let i = 0; i < 20; i++) schoolLoginLimited('198.51.100.1', `qui${i}`); // 10 pass, 10 blocked by IP
  const others = Array.from({ length: 30 }, (_, i) => schoolLoginLimited(`192.0.2.${i}`, `quo${i}`));
  assert.equal(others.indexOf(true), 18); // 30 − 2 (test above) − 10
});
