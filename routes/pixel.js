// Open tracking: GET /i/<id>.gif, the 1x1 image of a tracked email.
// first download sets email_sends.opened_at and a label of the app
import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { clientIp } from '../utils/limiter.js';

const router = express.Router();
const log = logger.child('pixel');

// 1x1 transparent GIF (43 bytes)
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Downloads this soon after the send are not opens (see the route).
export const EARLY_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IPv4 (also IPv4-mapped IPv6) in 17.0.0.0/8, Apple's network. */
const appleIp = (ip) => /^(::ffff:)?17\.\d+\.\d+\.\d+$/i.test(String(ip || ''));

/**
 * Which app downloaded the image: 'gmail' (Google's image proxy, at the first open),
 * 'apple' (Apple Mail Privacy Protection preloads every image: an approximation), 'altro'.
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
    const ua = req.get('user-agent');
    const ip = clientIp(req);
    const via = openedVia(ua, ip);
    try {
      // Not an open within EARLY_SECONDS of the send: a scanner fetching the images on delivery
      // (seen 8 s after an Azure send, not Google's proxy). The next download counts.
      const { rows } = await pool.query(
        `WITH s AS (SELECT id, opened_at, extract(epoch FROM now() - sent_at)::int AS age FROM email_sends WHERE id = $1),
              u AS (UPDATE email_sends e SET opened_at = now(), via = $2 FROM s
                     WHERE e.id = s.id AND s.opened_at IS NULL AND s.age >= $3 RETURNING e.id)
         SELECT s.age, s.opened_at IS NOT NULL AS already, EXISTS (SELECT 1 FROM u) AS opened FROM s`,
        [id, via, EARLY_SECONDS]
      );
      const r = rows[0];
      if (r?.opened) log.info('Email opened', { id, via, afterSeconds: r.age });
      // Only in the logs, never stored: who fetches right after the send.
      else if (r && !r.already) log.info('Image fetched right after the send, not an open', { id, afterSeconds: r.age, ua, ip });
    } catch (err) {
      log.error('Open not recorded', { error: err.message });
    }
  }
  res.status(200).end(GIF);
});

export default router;
