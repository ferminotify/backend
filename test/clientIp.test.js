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

test('clientIp: CLIENT_IP_HEADER from the hosting proxy chain', () => {
  process.env.CLIENT_IP_HEADER = 'True-Client-IP';
  try {
    const r = req('10.0.0.2', '203.0.113.7, 104.16.0.1');
    r.headers['true-client-ip'] = '203.0.113.7';
    assert.equal(clientIp(r), '203.0.113.7');
    assert.equal(clientIp(req('10.0.0.2', '203.0.113.7, 104.16.0.1')), '104.16.0.1'); // header missing: as before
    const direct = req('198.51.100.9');
    direct.headers['true-client-ip'] = '1.2.3.4';
    assert.equal(clientIp(direct), '198.51.100.9'); // not through the proxy: ignored
  } finally {
    delete process.env.CLIENT_IP_HEADER;
  }
});
