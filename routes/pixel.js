// Open tracking (docs/email-aperture.md): GET /i/<id>.gif, the 1x1 image of a tracked email.
// The first download sets email_sends.opened_at and a label of the app (via). The user agent
// and the IP only pick the label: neither is stored nor logged. Always the GIF, whatever the id
// (it must not tell which ids exist, and the image must never look broken in the email).
import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { clientIp } from '../utils/limiter.js';

const router = express.Router();
const log = logger.child('pixel');

// 1x1 transparent GIF (43 bytes)
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IPv4 (also IPv4-mapped IPv6) in 17.0.0.0/8, Apple's network. */
const appleIp = (ip) => /^(::ffff:)?17\.\d+\.\d+\.\d+$/i.test(String(ip || ''));

/**
 * Which app downloaded the image: 'gmail' (Google's image proxy, at the first open),
 * 'apple' (Apple Mail Privacy Protection preloads every image, read or not: an approximation,
 * Apple does not document its ranges), 'altro'.
 */
export function openedVia(userAgent, ip) {
  if (/GoogleImageProxy/i.test(String(userAgent || ''))) return 'gmail';
  if (appleIp(ip)) return 'apple';
  return 'altro';
}

router.get('/:file', async (req, res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  const id = String(req.params.file || '').replace(/\.gif$/i, '');
  if (UUID.test(id)) {
    try {
      await pool.query('UPDATE email_sends SET opened_at = now(), via = $2 WHERE id = $1 AND opened_at IS NULL', [
        id,
        openedVia(req.get('user-agent'), clientIp(req)),
      ]);
    } catch (err) {
      log.error('Open not recorded', { error: err.message });
    }
  }
  res.status(200).end(GIF);
});

export default router;
