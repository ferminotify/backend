import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriberRepository } from './subscriber.repository.js';

/** Minimal fake pg pool: records calls and returns a queued result. */
function fakePool(rows = []) {
    const calls = [];
    return {
        calls,
        async query(text, params) {
            calls.push({ text, params });
            return { rows, rowCount: rows.length };
        },
    };
}

test('findByEmail returns the row when found', async () => {
    const pool = fakePool([{ id: 1, email: 'a@b.it', name: 'Ada' }]);
    const repo = new SubscriberRepository(pool);

    const row = await repo.findByEmail('a@b.it');

    assert.equal(row.email, 'a@b.it');
    assert.equal(pool.calls.length, 1, 'exactly one round-trip');
    assert.deepEqual(pool.calls[0].params, ['a@b.it']);
});

test('findByEmail returns null (not a crash) when no row', async () => {
    const repo = new SubscriberRepository(fakePool([]));
    assert.equal(await repo.findByEmail('missing@b.it'), null);
});

test('findByTelegram returns null when no row', async () => {
    const repo = new SubscriberRepository(fakePool([]));
    assert.equal(await repo.findByTelegram('CODE123'), null);
});

test('confirmation flow needs a single query (regression: was 5)', async () => {
    const pool = fakePool([{ id: 1, email: 'a@b.it', name: 'Ada', gender: 'F', notifications: -1, unsub_token: 't' }]);
    const repo = new SubscriberRepository(pool);

    const sub = await repo.findByTelegram('CODE123');

    // Everything the welcome email needs comes from one row / one query.
    assert.equal(pool.calls.length, 1);
    assert.equal(sub.email, 'a@b.it');
    assert.equal(sub.gender, 'F');
    assert.equal(sub.name, 'Ada');
    assert.equal(sub.unsub_token, 't');
});

test('verifyOTP: not registered', async () => {
    const repo = new SubscriberRepository(fakePool([]));
    assert.equal(await repo.verifyOTP('x@y.it', 'ABC'), 'Email non registrata');
});

test('verifyOTP: expired', async () => {
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const repo = new SubscriberRepository(fakePool([{ secret_temp: 'ABC', secret_temp_timestamp: old }]));
    assert.equal(await repo.verifyOTP('x@y.it', 'ABC'), 'OTP scaduto');
});

test('verifyOTP: wrong code', async () => {
    const now = new Date().toISOString();
    const repo = new SubscriberRepository(fakePool([{ secret_temp: 'ABC', secret_temp_timestamp: now }]));
    assert.equal(await repo.verifyOTP('x@y.it', 'WRONG'), 'OTP non valido');
});

test('verifyOTP: valid', async () => {
    const now = new Date().toISOString();
    const repo = new SubscriberRepository(fakePool([{ secret_temp: 'ABC', secret_temp_timestamp: now }]));
    assert.equal(await repo.verifyOTP('x@y.it', 'ABC'), 'OK');
});
