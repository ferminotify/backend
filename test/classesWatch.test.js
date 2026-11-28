import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClasses, classKeys, inNewYearWindow } from '../utils/timetable/classesWatch.js';

const index = (...keys) => ({ class: keys.map((key) => ({ id: key, name: key, key })), room: [] });

// In-memory state and a recorded deploy hook.
function fakeDeps(stored = null, { hookFails = false } = {}) {
  const state = { value: stored, builds: 0 };
  return {
    state,
    deps: {
      hookUrl: 'https://hook.example/deploy',
      readState: async () => state.value,
      writeState: async (_key, value) => { state.value = value; },
      triggerBuild: async () => {
        if (hookFails) throw new Error('HTTP 500');
        state.builds++;
      },
    },
  };
}

test('inNewYearWindow: 25 August to 31 October', () => {
  assert.equal(inNewYearWindow(new Date(2026, 7, 24)), false);
  assert.equal(inNewYearWindow(new Date(2026, 7, 25)), true);
  assert.equal(inNewYearWindow(new Date(2026, 8, 15)), true);
  assert.equal(inNewYearWindow(new Date(2026, 9, 31)), true);
  assert.equal(inNewYearWindow(new Date(2026, 10, 1)), false);
  assert.equal(inNewYearWindow(new Date(2026, 2, 10)), false);
});

test('classKeys: sorted, unique', () => {
  assert.deepEqual(classKeys(index('2B', '1A', '2B')), ['1A', '2B']);
  assert.deepEqual(classKeys(null), []);
});

test('disabled without a deploy hook', async () => {
  const { deps, state } = fakeDeps('1A');
  assert.equal(await checkClasses(index('1B'), { ...deps, hookUrl: '' }), 'disabled');
  assert.equal(state.builds, 0);
});

test('first run records the classes without building', async () => {
  const { deps, state } = fakeDeps(null);
  assert.equal(await checkClasses(index('1A', '2A'), deps), 'initial');
  assert.equal(state.value, '1A,2A');
  assert.equal(state.builds, 0);
});

test('same classes: no build', async () => {
  const { deps, state } = fakeDeps('1A,2A');
  assert.equal(await checkClasses(index('2A', '1A'), deps), 'unchanged');
  assert.equal(state.builds, 0);
});

test('changed classes: one build, new classes remembered', async () => {
  const { deps, state } = fakeDeps('1A,2A');
  assert.equal(await checkClasses(index('1A', '2A', '3A'), deps), 'rebuild');
  assert.equal(state.builds, 1);
  assert.equal(state.value, '1A,2A,3A');
  assert.equal(await checkClasses(index('1A', '2A', '3A'), deps), 'unchanged');
  assert.equal(state.builds, 1);
});

test('empty or much shorter list: no build', async () => {
  const { deps, state } = fakeDeps('1A,1B,2A,2B');
  assert.equal(await checkClasses(index(), deps), 'empty');
  assert.equal(await checkClasses(index('1A'), deps), 'suspicious');
  assert.equal(state.builds, 0);
  assert.equal(state.value, '1A,1B,2A,2B');
});

test('failed deploy hook: classes not remembered, retried next time', async () => {
  const { deps, state } = fakeDeps('1A', { hookFails: true });
  assert.equal(await checkClasses(index('1A', '1B'), deps), 'error');
  assert.equal(state.value, '1A');
});
