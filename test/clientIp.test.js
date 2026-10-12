import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../utils/clientIp.js';

const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });

test('clientIp: X-Forwarded-For only from our proxy, its last entry', () => {
  // Through Caddy/nginx on the host or Docker's bridge: the proxy's entry (the last one).
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req('::ffff:172.18.0.1', '1.2.3.4, 203.0.113.7')), '203.0.113.7'); // first one forged
  // Straight to the port: the header is the client's own, ignored.
  assert.equal(clientIp(req('198.51.100.9', '1.2.3.4')), '198.51.100.9');
  assert.equal(clientIp(req('::ffff:198.51.100.9')), '198.51.100.9');
  // Proxy without the header: the proxy's address.
  assert.equal(clientIp(req('10.0.0.2')), '10.0.0.2');
});
