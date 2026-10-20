import express from 'express';
import { clientIp } from '../utils/clientIp.js';
import { schoolLoginLimited } from '../utils/schoolLoginLimit.js';
import logger from '../utils/logger.js';
import {
  ALL_TYPES,
  getIndex,
  getWeek,
  hasCredentials,
  loginWith,
  logoutSession,
  sessionSeesTeachers,
  testVariation,
  testExamples,
  SchoolLoginError,
  SchoolSessionExpired,
} from '../utils/timetable/index.js';
import { optionalSchoolUser } from '../utils/schoolAccess.js';
import { optionalSchoolTicket, sealTicket } from '../utils/schoolTicket.js';

const router = express.Router();
const log = logger.child('timetable');

// Teachers are shown to:
// - confirmed @fermimn.edu.it Fermi Notify accounts (utils/schoolAccess.js), fetched with
//   the service account from the env;
// - users logged in with their own school (Moodle) credentials (utils/schoolTicket.js),
//   fetched with their session.
const canSeeTeachers = (req) => Boolean(req.schoolSession || req.schoolUser);

// Public, read-only. Short browser cache: variations change during the day.
// Responses with teachers are never cached by browsers or proxies.
const setCache = (req, res, seconds) => {
  res.set('Vary', 'Authorization, X-School-Ticket');
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

// --- "Accedi con Moodle" ---------------------------------------------------------------

router.post('/school-login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || username.length > 150 || password.length > 256) {
    return res.status(400).json({ error: 'Inserisci nome utente e password' });
  }
  if (schoolLoginLimited(clientIp(req), username)) {
    return res.status(429).json({ error: 'Troppi tentativi, riprova tra qualche minuto' });
  }

  let session;
  try {
    session = await loginWith(username, password);
  } catch (err) {
    if (err instanceof SchoolLoginError) {
      log.info('School login rejected', { ip: clientIp(req) });
      return res.status(401).json({ error: 'Nome utente o password errati', code: 'school_login_failed' });
    }
    log.error('School login error', { error: err.message });
    return res.status(502).json({ error: 'Sito della scuola non raggiungibile' });
  }

  try {
    if (!(await sessionSeesTeachers(session))) {
      await logoutSession(session);
      return res.status(403).json({ error: 'Il tuo account non ha accesso all’orario dei docenti', code: 'school_no_access' });
    }
  } catch (err) {
    log.error('School access check failed', { error: err.message });
    return res.status(502).json({ error: 'Sito della scuola non raggiungibile' });
  }

  checkedSessions.set(session.sessionid, Date.now());
  log.info('School login success', { ip: clientIp(req) });
  res.json({ ticket: sealTicket(session) });
});

router.post('/school-logout', optionalSchoolTicket, async (req, res) => {
  if (req.schoolSession) {
    checkedSessions.delete(req.schoolSession.sessionid);
    await logoutSession(req.schoolSession);
  }
  res.status(204).end();
});

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

router.use(optionalSchoolTicket, liveSchoolSession, optionalSchoolUser);

/** Classes and rooms on the school timetable; also teachers for those allowed. */
router.get('/', async (req, res) => {
  const session = req.schoolSession || undefined;
  try {
    const authed = Boolean(session) || (Boolean(req.schoolUser) && hasCredentials());
    const pub = await getIndex();
    let priv = null;
    if (authed) {
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
      schoolUser: Boolean(req.schoolUser),
      schoolSession: Boolean(session),
    });
  } catch (err) {
    if (err instanceof SchoolSessionExpired) return sessionExpired(res);
    log.error('Index failed', { error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

/** Test page: random calendar events to try. */
router.get('/test/examples', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ examples: await testExamples() });
  } catch (err) {
    log.error('Examples failed', { error: err.message });
    res.status(502).json({ error: 'Calendario non raggiungibile' });
  }
});

/** Test page: how an event title is read and applied. ?summary=&date=YYYY-MM-DD&start=HH:MM&end=HH:MM */
router.get('/test', async (req, res) => {
  const summary = typeof req.query.summary === 'string' ? req.query.summary.trim().slice(0, 500) : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  const time = (t) => (/^\d{2}:\d{2}$/.test(t) ? t : null);
  const start = time(req.query.start);
  const allDay = req.query.allDay === '1' || !start;
  if (!summary || !date) return res.status(400).json({ error: 'Servono testo dell’evento e data' });
  try {
    const out = await withOwnSession(req, () =>
      testVariation(
        { summary, date, start, end: time(req.query.end) || start, allDay },
        { authed: canSeeTeachers(req), session: req.schoolSession || undefined }
      )
    );
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (err) {
    if (err instanceof SchoolSessionExpired) return sessionExpired(res);
    log.error('Test failed', { error: err.message });
    res.status(502).json({ error: 'Orario della scuola non raggiungibile' });
  }
});

/** Week timetable with variations applied. ?date=YYYY-MM-DD picks the week (default: current). */
router.get('/:type/:ref', async (req, res) => {
  const type = { classe: 'class', aula: 'room', docente: 'teacher' }[req.params.type] || req.params.type;
  if (!ALL_TYPES.includes(type)) return res.status(404).json({ error: 'Tipo non valido' });
  if (type === 'teacher' && !canSeeTeachers(req)) {
    return res.status(403).json({ error: 'Orario docenti disponibile solo accedendo con Moodle o con un account @fermimn.edu.it' });
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
