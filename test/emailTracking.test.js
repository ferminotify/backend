import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { bounceStatus, mailgunSignatureOk } from '../utils/emailBounces.js';
import { openedVia } from '../routes/pixel.js';

test('bounceStatus: only a deleted mailbox is unknown_user', () => {
  assert.equal(bounceStatus('550 5.1.1 The email account that you tried to reach does not exist.'), 'unknown_user');
  assert.equal(bounceStatus('550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'), 'unknown_user');
  assert.equal(bounceStatus('550 No such user here'), 'unknown_user');
  assert.equal(bounceStatus('user unknown'), 'unknown_user');
  // Suspended, full, blocked: the mailbox exists.
  assert.equal(bounceStatus('550 5.2.1 The email account that you tried to reach is disabled.'), 'failed');
  assert.equal(bounceStatus('552 5.2.2 The recipient\'s inbox is out of storage space.'), 'failed');
  assert.equal(bounceStatus('550 5.7.1 Message rejected due to local policy'), 'failed');
  assert.equal(bounceStatus(''), 'failed');
  // Azure did not try; Mailgun gave up retrying temporary errors.
  assert.equal(bounceStatus('550 5.1.1 does not exist', { suppressed: true }), 'suppressed');
  assert.equal(bounceStatus('Too old: 421 4.7.0 Try again later', { tooOld: true }), 'failed');
});

test('mailgunSignatureOk: HMAC of timestamp + token, at most 5 minutes old', () => {
  const key = 'signing-key';
  const now = 1_800_000_000_000;
  const sign = (timestamp, token, k = key) => ({
    timestamp: String(timestamp),
    token,
    signature: crypto.createHmac('sha256', k).update(String(timestamp) + token).digest('hex'),
  });
  assert.equal(mailgunSignatureOk(sign(now / 1000, 'tok'), key, now), true);
  assert.equal(mailgunSignatureOk(sign(now / 1000, 'tok', 'other'), key, now), false); // wrong key
  assert.equal(mailgunSignatureOk(sign(now / 1000 - 600, 'tok'), key, now), false); // too old
  assert.equal(mailgunSignatureOk({ ...sign(now / 1000, 'tok'), token: 'changed' }, key, now), false);
  assert.equal(mailgunSignatureOk(undefined, key, now), false);
  assert.equal(mailgunSignatureOk(sign(now / 1000, 'tok'), '', now), false); // hook off
});

test('openedVia: Gmail proxy, Apple network, else altro', () => {
  assert.equal(openedVia('Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', '66.249.84.1'), 'gmail');
  assert.equal(openedVia('Mozilla/5.0', '17.58.100.4'), 'apple');
  assert.equal(openedVia('Mozilla/5.0', '::ffff:17.1.2.3'), 'apple');
  assert.equal(openedVia('Mozilla/5.0', '170.1.2.3'), 'altro');
  assert.equal(openedVia(undefined, undefined), 'altro');
});
