import test from 'node:test';
import assert from 'node:assert/strict';
import { limited } from '../routes/report.js';

test('report limits: an address over its own limit does not use up the shared budget', () => {
  for (let i = 0; i < 5; i++) assert.equal(limited('203.0.113.1'), false);
  // The same address keeps trying: refused every time…
  for (let i = 0; i < 100; i++) assert.equal(limited('203.0.113.1'), true);
  // …while the others still get through (the hourly total counted only 5 so far).
  for (let i = 0; i < 11; i++) assert.equal(limited(`198.51.100.${i}`), false);
});
