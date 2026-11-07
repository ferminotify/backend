// "Accedi con Moodle": a Fermi Notify account tied to a school (Moodle) account.
//
// POST /            username + password → checked on the school site (the password is only
//                   forwarded there, never stored or logged). Known account → logged in.
//                   New one → a short-lived signup token 
// POST /complete    signup token + name, surname, gender, email → account created; can log in 
//                   once the email is confirmed.
//                   An email that already has an account gets a "Collega Moodle" link instead.
//                   Unconfirmed yet (maybe a mistyped email): logging in with Moodle shows this
//                   step again, filled in; completing it updates that account (new address, new
//                   confirmation link: the old one stops working).
// POST /link        the link's token (from that email) → Moodle linked to the account, logged in.
//
// The school session of POST / travels sealed in the signup token, then in the link token:
// /link reuses it for the teachers (no second school login). Closed on the other outcomes.
//
// The account can also log in with its email and the Moodle password: /login checks it on
// the school site. The password is never stored.
import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { clientIp, schoolLoginFailed, schoolLoginLimited, schoolLoginSucceeded } from '../utils/limiter.js';
import { generateRefreshToken } from '../utils/auth.js';
import { getTelegramTemporaryCode } from '../utils/telegram.js';
import { sendConfirmationEmail, sendMoodleLinkEmail } from '../utils/email.js';
import { FRONTEND_BASE } from '../utils/google.js';
import { openTicket, sealTicket, teacherTicket } from '../utils/schoolTicket.js';
import { loginWith, logoutSession, SchoolLoginError } from '../utils/timetable/index.js';
import { signupKeywordList } from '../utils/timetable/match.js';

const router = express.Router();
const log = logger.child('moodle-auth');

const SIGNUP_PURPOSE = 'moodle_signup';
const LINK_PURPOSE = 'moodle_link';
const LINK_TTL = '30m';
const LINK_EMAIL_EVERY_MS = 5 * 60 * 1000;
const linkEmailSent = new Map(); // user id -> time
const SIGNUP_TTL = '30m';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** "mario.rossi@gmail.com" → "m•••@gmail.com": shown to whoever logs in with that Moodle. */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 1)}•••@${domain}`;
}

async function startSession(res, user) {
  const refreshToken = await generateRefreshToken(user.id, YEAR_MS);
  await pool
    .query("UPDATE subscribers SET last_login = (NOW() AT TIME ZONE 'UTC') WHERE id = $1", [user.id])
    .catch((e) => log.warn('Failed to update last_login (Moodle)', { id: user.id, error: e.message }));
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: YEAR_MS,
  });
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/** Logs out the school session sealed in a signup/link token, if any. */
function closeTokenSession(claims) {
  const session = claims?.ticket && openTicket(claims.ticket);
  if (session) logoutSession(session);
}

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password || username.length > 150 || password.length > 256) {
    return res.status(400).json({ error: 'Inserisci nome utente e password' });
  }
  if (schoolLoginLimited(clientIp(req), username)) {
    return res.status(429).json({ error: 'Troppi tentativi, riprova più tardi' });
  }

  let session;
  try {
    session = await loginWith(username, password);
  } catch (err) {
    if (err instanceof SchoolLoginError) {
      schoolLoginFailed(username);
      log.info('Moodle login rejected', { ip: clientIp(req) });
      return res.status(401).json({ error: 'Nome utente o password errati', code: 'school_login_failed' });
    }
    log.error('Moodle login error', { error: err.message });
    return res.status(502).json({ error: 'Moodle Fermi non raggiungibile, riprova più tardi' });
  }
  schoolLoginSucceeded(username);
  const schoolUsername = username; // as typed: the school site checks it case-sensitively

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, surname, gender, onboarding, notifications FROM subscribers WHERE lower(school_username) = lower($1)',
      [schoolUsername]
    );
    if (rows[0] && rows[0].notifications < 0) {
      // Signed up, email not confirmed: the signup step again, to fix the address if wrong.
      // The Moodle password proves it is them; the address is shown masked.
      const u = rows[0];
      const signup = jwt.sign({ purpose: SIGNUP_PURPOSE, schoolUsername, pendingId: u.id, ticket: sealTicket(session) }, process.env.JWT_SECRET, {
        expiresIn: SIGNUP_TTL,
      });
      log.info('Moodle signup resumed (email not confirmed)', { id: u.id, ip: clientIp(req) });
      return res.json({ signup, pending: { name: u.name, surname: u.surname, gender: u.gender, email: maskEmail(u.email) } });
    }
    if (rows[0]) {
      const token = await startSession(res, rows[0]);
      await pool.query('UPDATE subscribers SET onboarding = TRUE WHERE id = $1', [rows[0].id]);
      log.info('Moodle login success', { id: rows[0].id, ip: clientIp(req) });
      return res.json({ token, ticket: await teacherTicket(session, rows[0].id), onboarding: !rows[0].onboarding });
    }
  } catch (err) {
    log.error('Moodle login DB error', { error: err.stack || err });
    logoutSession(session);
    return res.status(500).json({ error: 'Errore interno, riprova più tardi' });
  }

  // First time: the school site only proves the account exists, the rest is asked next.
  const signup = jwt.sign({ purpose: SIGNUP_PURPOSE, schoolUsername, ticket: sealTicket(session) }, process.env.JWT_SECRET, { expiresIn: SIGNUP_TTL });
  log.info('Moodle signup started', { ip: clientIp(req) });
  return res.json({ signup });
});

router.post('/complete', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let claims;
  try {
    claims = jwt.verify(String(req.body?.signup || ''), process.env.JWT_SECRET);
    if (claims.purpose !== SIGNUP_PURPOSE || !claims.schoolUsername) throw new Error('wrong token');
  } catch {
    return res.status(401).json({ error: 'Accesso con Moodle scaduto, accedi di nuovo', code: 'moodle_signup_expired' });
  }

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = str(req.body.name, 50);
  const surname = str(req.body.surname, 50);
  const email = str(req.body.email, 50).toLowerCase();
  const gender = req.body.gender;
  if (!name || !surname || !email) return res.status(400).json({ error: 'Compila tutti i campi!' });
  if (!['M', 'F', 'X'].includes(gender)) return res.status(400).json({ error: 'Genere non valido!' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email non valida!' });
  const tags = await signupKeywordList(req.body.keywords ?? req.body.keyword);
  if (!tags) return res.status(400).json({ error: 'Scrivi la tua classe o il tuo cognome.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Resumed signup (POST /): this unconfirmed account, still unconfirmed and still theirs.
    let pending = null;
    if (claims.pendingId) {
      const p = await client.query(
        'SELECT id FROM subscribers WHERE id = $1 AND lower(school_username) = lower($2) AND notifications < 0 FOR UPDATE',
        [claims.pendingId, claims.schoolUsername]
      );
      pending = p.rows[0] || null;
    }
    const taken = await client.query(
      'SELECT id, notifications, school_username FROM subscribers WHERE (lower(email) = lower($1) OR lower(school_username) = lower($2)) AND id <> $3',
      [email, claims.schoolUsername, pending?.id ?? -1]
    );
    if (taken.rows.some((r) => r.school_username?.toLowerCase() === claims.schoolUsername.toLowerCase())) {
      await client.query('ROLLBACK');
      closeTokenSession(claims);
      return res.status(409).json({ error: 'Questo account Moodle è già registrato: accedi di nuovo con Moodle', code: 'moodle_taken' });
    }
    if (taken.rowCount) {
      // The address has an account (password or Google). Typing it proves nothing: the owner
      // links Moodle from a link sent there (POST /link), or nothing changes.
      await client.query('ROLLBACK');
      const { rows } = await pool.query('SELECT id, name, gender, school_username FROM subscribers WHERE lower(email) = lower($1)', [email]);
      const owner = rows[0];
      if (owner?.school_username) {
        closeTokenSession(claims);
        return res.status(409).json({ error: 'Questa email è già collegata a un altro account Moodle', code: 'email_taken' });
      }
      const last = linkEmailSent.get(owner.id) || 0;
      if (Date.now() - last > LINK_EMAIL_EVERY_MS) {
        // The keywords chosen here replace those of an account never confirmed (POST /link)
        const link = jwt.sign(
          { purpose: LINK_PURPOSE, userId: owner.id, schoolUsername: claims.schoolUsername, tags, ticket: claims.ticket },
          process.env.JWT_SECRET,
          { expiresIn: LINK_TTL }
        );
        await sendMoodleLinkEmail(email, {
          name: owner.name,
          gender: owner.gender,
          schoolUsername: claims.schoolUsername,
          link: `${FRONTEND_BASE}/collega-moodle?t=${encodeURIComponent(link)}`,
        });
        linkEmailSent.set(owner.id, Date.now());
        if (linkEmailSent.size > 5000) linkEmailSent.delete(linkEmailSent.keys().next().value);
        log.info('Moodle link email sent', { id: owner.id, ip: clientIp(req) });
      }
      // Not closed when no email goes: it may be the one in the link sent just before
      return res.status(202).json({ linkSent: true });
    }
    // notifications = -1: unconfirmed until the link in the email is opened (as /register).
    const code = await getTelegramTemporaryCode();
    if (pending) {
      // New address and code: the link sent to the old address stops working.
      const upd = await client.query(
        `UPDATE subscribers SET name = $1, surname = $2, email = $3, gender = $4, telegram = $5, tags = COALESCE($7::text[], tags)
          WHERE id = $6 RETURNING id, email, unsub_token`,
        [name, surname, email, gender, code, pending.id, tags.length ? tags : null]
      );
      const user = upd.rows[0];
      await sendConfirmationEmail(email, {
        name,
        gender,
        code,
        unsubInfo: { id: user.id, unsub_token: user.unsub_token },
        schoolUsername: claims.schoolUsername,
      });
      await client.query('COMMIT');
      closeTokenSession(claims);
      log.info('Moodle signup updated (email not confirmed)', { id: user.id, ip: clientIp(req) });
      return res.status(201).json({ confirmSent: true });
    }
    const ins = await client.query(
      `INSERT INTO subscribers
         (name, surname, email, school_username, gender, notifications, notification_preferences, profile_complete, telegram, onboarding, tags)
       VALUES ($1, $2, $3, $4, $5, -1, 2, TRUE, $6, TRUE, $7)
       RETURNING id, email, unsub_token`,
      [name, surname, email, claims.schoolUsername, gender, code, tags.length ? tags : null]
    );
    const user = ins.rows[0];
    await sendConfirmationEmail(email, {
      name,
      gender,
      code,
      unsubInfo: { id: user.id, unsub_token: user.unsub_token },
      schoolUsername: claims.schoolUsername,
    });
    await client.query('COMMIT');
    closeTokenSession(claims);

    // No session yet: the account enters once the email is confirmed.
    log.info('Moodle signup completed', { id: user.id, ip: clientIp(req) });
    return res.status(201).json({ confirmSent: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Email o account Moodle già registrati' });
    log.error('Moodle signup failed', { error: err.stack || err });
    return res.status(500).json({ error: 'Errore interno, riprova più tardi' });
  } finally {
    client.release();
  }
});

/** "Collega Moodle" page: the owner of the address confirms. Links the account and logs in. */
router.post('/link', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let claims;
  try {
    claims = jwt.verify(String(req.body?.token || ''), process.env.JWT_SECRET);
    if (claims.purpose !== LINK_PURPOSE || !claims.userId || !claims.schoolUsername) throw new Error('wrong token');
  } catch {
    return res.status(401).json({ error: 'Link scaduto o non valido: accedi di nuovo con Moodle', code: 'moodle_link_invalid' });
  }
  try {
    const other = await pool.query('SELECT id, notifications FROM subscribers WHERE lower(school_username) = lower($1) AND id <> $2', [
      claims.schoolUsername,
      claims.userId,
    ]);
    if (other.rows.some((r) => r.notifications >= 0)) {
      closeTokenSession(claims);
      return res.status(409).json({ error: 'Questo account Moodle è già collegato a un altro account' });
    }
    // An unconfirmed signup with this Moodle (an address that was not theirs): replaced by this one.
    if (other.rowCount) {
      await pool.query('DELETE FROM subscribers WHERE lower(school_username) = lower($1) AND id <> $2 AND notifications < 0', [
        claims.schoolUsername,
        claims.userId,
      ]);
    }
    // Only an account without Moodle yet; the same link twice is fine.
    const tags = Array.isArray(claims.tags) && claims.tags.length ? claims.tags.map(String) : null;
    const upd = await pool.query(
      `UPDATE subscribers s SET school_username = $1, notifications = GREATEST(s.notifications, 0),
              password = CASE WHEN s.notifications < 0 THEN NULL ELSE s.password END,
              tags = CASE WHEN s.notifications < 0 AND $3::text[] IS NOT NULL THEN $3::text[] ELSE s.tags END
         FROM (SELECT notifications AS was FROM subscribers WHERE id = $2) old
        WHERE s.id = $2 AND (s.school_username IS NULL OR lower(s.school_username) = lower($1))
        RETURNING s.id, s.email, s.onboarding, old.was`,
      [claims.schoolUsername, claims.userId, tags]
    );
    if (!upd.rowCount) {
      closeTokenSession(claims);
      return res.status(409).json({ error: 'Questo account è già collegato a un altro account Moodle' });
    }
    const user = upd.rows[0];
    if ((user.was ?? 0) < 0) {
      await pool.query('DELETE FROM refresh_tokens WHERE sub_id = $1', [user.id]);
      log.info('Moodle claimed an unconfirmed account: earlier password and sessions dropped, keywords replaced', { id: user.id });
    }
    const token = await startSession(res, user);
    // The signup's school session: teachers without logging in again (kept with its expiry)
    const session = claims.ticket && openTicket(claims.ticket);
    const ticket = session ? await teacherTicket(session, user.id, claims.ticket) : null;
    log.info('Moodle linked to existing account', { id: user.id, ip: clientIp(req), teachers: Boolean(ticket) });
    return res.json({ token, ticket, onboarding: !user.onboarding });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Questo account Moodle è già collegato a un altro account' });
    log.error('Moodle link failed', { error: err.stack || err });
    return res.status(500).json({ error: 'Errore interno, riprova più tardi' });
  }
});

/** What the "Collega Moodle" page shows before confirming. */
router.post('/link/info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const claims = jwt.verify(String(req.body?.token || ''), process.env.JWT_SECRET);
    if (claims.purpose !== LINK_PURPOSE) throw new Error('wrong token');
    return res.json({ schoolUsername: claims.schoolUsername });
  } catch {
    return res.status(401).json({ error: 'Link scaduto o non valido: accedi di nuovo con Moodle', code: 'moodle_link_invalid' });
  }
});

export default router;
