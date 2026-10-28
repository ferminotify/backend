import express from 'express';
import crypto from 'crypto';
import { clientIp, searchLimited } from '../utils/limiter.js';
import logger from '../utils/logger.js';
import {
  ALL_TYPES,
  getIndex,
  getWeek,
  sessionSeesTeachers,
  upcomingEvents,
  SchoolSessionExpired,
} from '../utils/timetable/index.js';
import { matchKeywords } from '../utils/timetable/keywords.js';
import { calendarSurnames } from '../utils/timetable/calendarNames.js';
import { forgetTicket, optionalSchoolTicket } from '../utils/schoolTicket.js';

const router = express.Router();
const log = logger.child('timetable');

// Teachers only for accounts logged in with Moodle that the school lets see them (ticket from
// routes/moodle.js, routes/auth.js), fetched with that session. Everyone else: the surnames
// the public calendar prints, for keyword suggestions only (utils/timetable/calendarNames.js).
const canSeeTeachers = (req) => Boolean(req.schoolSession);

// Public, read-only. Short browser cache: variations change during the day.
// Responses with teachers are never cached by browsers or proxies.
const setCache = (req, res, seconds) => {
  res.set('Vary', 'X-School-Ticket');
  res.set('Cache-Control', canSeeTeachers(req) ? 'private, no-store' : `public, max-age=${seconds}`);
};

const sessionExpired = (res) =>
  res.status(401).json({ error: 'Sessione Moodle scaduta, accedi di nuovo', code: 'school_session_expired' });

/**
 * Runs `fn`; when it fails because of a school session that is not this request's
 * (the cache shares in-flight fetches between users), runs it again.
 */
async function withOwnSession(req, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SchoolSessionExpired && err.session !== req.schoolSession) return fn();
    throw err;
  }
}

// --- Timetable -------------------------------------------------------------------------

// Most data comes from the shared cache, so a user's session would rarely be used and a
// ticket would keep working after its session ended (logout, password change). Check it
// on the school site at most every 30 minutes.
const SESSION_CHECK_MS = 30 * 60 * 1000;
const checkedSessions = new Map(); // sessionid -> last successful check

async function liveSchoolSession(req, res, next) {
  const session = req.schoolSession;
  if (!session) return next();
  const at = checkedSessions.get(session.sessionid);
  if (at && Date.now() - at < SESSION_CHECK_MS) return next();
  try {
    if (!(await sessionSeesTeachers(session))) throw new SchoolSessionExpired('No teacher access');
  } catch (err) {
    if (err instanceof SchoolSessionExpired) {
      checkedSessions.delete(session.sessionid);
      forgetTicket(req.headers['x-school-ticket']);
      return sessionExpired(res);
    }
    log.warn('School session check failed', { error: err.message });
    return next(); // school site down: keep serving (cached) data
  }
  checkedSessions.delete(session.sessionid);
  checkedSessions.set(session.sessionid, Date.now());
  if (checkedSessions.size > 5000) checkedSessions.delete(checkedSessions.keys().next().value);
  next();
}

// Before the session middleware: the notifier's Bearer key is not a user token.
// --- Event search: "Cerca eventi", dashboard, notifier ------------------------------------
// One endpoint, so a keyword finds the same events everywhere (rules: utils/timetable/keywords.js).
// The notifier (Bearer NOTIFICATION_API_KEY, as /user/push/notify) only skips the limits:
// it asks for every user's keywords at once, every few minutes.
const SEARCH_MAX_KEYWORDS = 20000;
const PUBLIC_MAX_KEYWORDS = 20;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isNotifier(req) {
  const key = process.env.NOTIFICATION_API_KEY || '';
  const expected = Buffer.from(`Bearer ${key}`);
  const received = Buffer.from(req.headers.authorization || '');
  return Boolean(key) && received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/**
 * POST { keywords?: [string], from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }  (days included,
 * from today on; default: every upcoming day the calendar has)
 *   → { events: [{uid, summary, date, start, end, allDay}],
 *       matches: { keyword: [uid] }, optional: { keyword: { category: [uid] } }, source, stale }
 * No keywords: every event of those days. With keywords: the events any of them finds,
 * opt-in activities included (`optional`: help desks… reaching the keyword's class only through
 * its year/group, utils/timetable/optIn.js; the notifier sends them only to who chose them).
 * Public: only the public calendar's titles and uids, never the school's teacher list.
 */
router.post('/search', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const notifier = isNotifier(req);
  if (!notifier && req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
  const { keywords = [], from, to } = req.body || {};
  if (!Array.isArray(keywords)) return res.status(400).json({ error: 'keywords must be an array' });
  if ((from != null && !ISO_DAY.test(from)) || (to != null && !ISO_DAY.test(to))) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }
  const max = notifier ? SEARCH_MAX_KEYWORDS : PUBLIC_MAX_KEYWORDS;
  if (keywords.length > max) return res.status(400).json({ error: `At most ${max} keywords` });
  if (!notifier && searchLimited(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste, riprova tra poco' });

  const kws = [...new Set(keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.slice(0, 100)))];
  try {
    const started = Date.now();
    const { events: upcoming, source, stale } = await upcomingEvents();
    const inRange = upcoming.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));
    if (!kws.length) return res.json({ events: inRange, matches: {}, optional: {}, source, stale });
    const { matches, optional } = await matchKeywords(inRange, kws);
    const found = new Set([
      ...Object.values(matches).flat(),
      ...Object.values(optional).flatMap((cats) => Object.values(cats).flat()),
    ]);
    log.info('Events searched', { by: notifier ? 'notifier' : 'public', events: inRange.length, keywords: kws.length, found: found.size, ms: Date.now() - started });
    res.json({ events: inRange.filter((e) => found.has(e.uid)), matches, optional, source, stale });
  } catch (err) {
    log.error('Event search failed', { error: err.message });
    res.status(502).json({ error: 'Calendario non raggiungibile' });
  }
});

router.use(optionalSchoolTicket, liveSchoolSession);

/** Classes and rooms on the school timetable; also teachers for those allowed. */
router.get('/', async (req, res) => {
  const session = req.schoolSession || undefined;
  try {
    const pub = await getIndex();
    let priv = null;
    if (session) {
      priv = await withOwnSession(req, () => getIndex({ authed: true, session })).catch((err) => {
        if (err instanceof SchoolSessionExpired) throw err;
        return null;
      });
    }
    const list = (l) => (l || []).map(({ key, name }) => ({ key, name }));
    setCache(req, res, 3600);
    res.json({
      classes: list(pub.class),
      rooms: list(pub.room),
      // null = not available to this user; [] = allowed but the school site failed
      teachers: canSeeTeachers(req) ? list(priv?.teacher) : null,
      // Public: surnames printed in the calendar's titles (keyword suggestions)
      calendarTeachers: calendarSurnames(),
      schoolSession: Boolean(session),
    });
  } catch (err) {
    if (err instanceof SchoolSessionExpired) return sessionExpired(res);
    log.error('Index failed', { error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

/** Week timetable with variations applied. ?date=YYYY-MM-DD picks the week (default: current). */
router.get('/:type/:ref', async (req, res) => {
  const type = { classe: 'class', aula: 'room', docente: 'teacher' }[req.params.type] || req.params.type;
  if (!ALL_TYPES.includes(type)) return res.status(404).json({ error: 'Tipo non valido' });
  if (type === 'teacher' && !canSeeTeachers(req)) {
    return res.status(403).json({ error: 'Orario docenti disponibile solo accedendo con Moodle' });
  }

  try {
    const opts = { date: req.query.date, authed: canSeeTeachers(req), session: req.schoolSession || undefined };
    const week = await withOwnSession(req, () => getWeek(type, req.params.ref, opts));
    if (!week) return res.status(404).json({ error: 'Classe, aula o docente non trovato' });
    setCache(req, res, 60);
    res.json(week);
  } catch (err) {
    if (err instanceof SchoolSessionExpired) return sessionExpired(res);
    log.error('Week failed', { type, ref: req.params.ref, error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

export default router;
