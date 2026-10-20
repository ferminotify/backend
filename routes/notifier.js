// For the notifier (ferminotify/notifier): which events concern which keywords, with the
// timetable's rules (utils/timetable/keywords.js). The notifier keeps its own event source
// and uids (what was already sent); it only asks for the matching.
// Auth: the same NOTIFICATION_API_KEY as /user/push/notify.
import express from 'express';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { matchKeywords } from '../utils/timetable/keywords.js';

const router = express.Router();
const log = logger.child('notifier');

const MAX_EVENTS = 2000;
const MAX_KEYWORDS = 20000;

function requireNotifierKey(req, res, next) {
  const key = process.env.NOTIFICATION_API_KEY || '';
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(req.headers.authorization || '');
  if (!key || received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST { events: [{uid, summary}], keywords: [string] }
 *   → { matches: { keyword: [uid] }, optional: { keyword: { category: [uid] } } }
 * `optional`: opt-in activities reaching the keyword's class only through its year/group
 * (utils/timetable/optIn.js), to send only to users with that category in notify_optin.
 */
router.post('/match', express.json({ limit: '2mb' }), requireNotifierKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { events, keywords } = req.body || {};
  if (!Array.isArray(events) || !Array.isArray(keywords) || events.length > MAX_EVENTS || keywords.length > MAX_KEYWORDS) {
    return res.status(400).json({ error: 'events and keywords must be arrays' });
  }
  const kws = keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.slice(0, 100));
  try {
    const started = Date.now();
    const { matches, optional } = await matchKeywords(events.slice(0, MAX_EVENTS), kws);
    log.info('Keywords matched', { events: events.length, keywords: kws.length, ms: Date.now() - started });
    res.json({ matches, optional });
  } catch (err) {
    log.error('Keyword match failed', { error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

export default router;
