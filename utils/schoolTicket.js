// "Accedi con Moodle": a user's own session on fermimn.edu.it, handed to the browser as an
// opaque ticket (AES-256-GCM, so the client can neither read nor forge it). Stateless:
// survives restarts, nothing stored server side. The password never gets here.
import crypto from 'node:crypto';
import pool from '../db.js';
import logger from './logger.js';
import { logoutSession, sessionSeesTeachers } from './timetable/index.js';

const log = logger.child('school-ticket');

// Django's session cookie lives 14 days; stop a bit earlier.
export const TICKET_TTL_MS = 13 * 24 * 60 * 60 * 1000;

const key = () => {
  const secret = process.env.SCHOOL_TICKET_SECRET || process.env.JWT_SECRET;
  // Without a secret the key would be guessable and tickets forgeable: refuse instead.
  if (!secret) throw new Error('SCHOOL_TICKET_SECRET / JWT_SECRET not set');
  return crypto.createHash('sha256').update(`school-ticket:${secret}`).digest();
};

/** @param {{ sessionid: string, csrftoken?: string }} session */
export function sealTicket(session, now = Date.now()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = JSON.stringify({ s: session.sessionid, c: session.csrftoken, e: now + TICKET_TTL_MS });
  const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

/**
 * Ticket only for accounts the school lets see the teachers (else null, session closed).
 * Saved on the account: its other logins reuse it while valid (profile, routes/user.js).
 */
export async function teacherTicket(session, userId) {
  let ticket = sealTicket(session);
  try {
    if (!(await sessionSeesTeachers(session))) {
      await logoutSession(session);
      ticket = null;
    }
  } catch {
    // school site down: checked again on first use (routes/timetable.js)
  }
  await pool
    .query('UPDATE subscribers SET school_ticket = $1 WHERE id = $2', [ticket, userId])
    .catch((err) => log.warn('School ticket not saved', { userId, error: err.message }));
  return ticket;
}

/** A dead session is no longer offered to the account's logins. */
export function forgetTicket(ticket) {
  return pool.query('UPDATE subscribers SET school_ticket = NULL WHERE school_ticket = $1', [String(ticket)]).catch(() => {});
}

/** The session in the ticket, or null if the ticket is invalid or expired. */
export function openTicket(ticket, now = Date.now()) {
  try {
    const raw = Buffer.from(String(ticket), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (!body.s || !(body.e > now)) return null;
    return { sessionid: body.s, ...(body.c ? { csrftoken: body.c } : {}) };
  } catch {
    return null;
  }
}

/**
 * Sets req.schoolSession from the X-School-Ticket header. A bad or expired ticket is
 * rejected (401, code "school_ticket_invalid") so the client drops it.
 */
export function optionalSchoolTicket(req, res, next) {
  req.schoolSession = null;
  const ticket = req.headers['x-school-ticket'];
  if (!ticket) return next();
  req.schoolSession = openTicket(ticket);
  if (!req.schoolSession) {
    return res.status(401).json({ error: 'Sessione Moodle scaduta', code: 'school_ticket_invalid' });
  }
  next();
}
