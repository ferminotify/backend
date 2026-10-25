// Gate for data the school only shows to its own users (teachers' timetables, from its
// reserved area): a Fermi Notify account with a confirmed @fermimn.edu.it address, read
// with the service account from the env (routes/timetable.js). Everyone else gets only the
// surnames the public calendar prints (utils/timetable/calendarNames.js).
//
// The JWT alone is not enough: /login issues tokens to unconfirmed accounts too, so
// anyone could register "someone@fermimn.edu.it" without owning it. The account is
// re-read from the DB and must be confirmed (notifications > -1; Google sign-ups are
// created confirmed, and only with a Google-verified email).
import jwt from 'jsonwebtoken';
import pool from '../db.js';

export const SCHOOL_DOMAIN = '@fermimn.edu.it';

/** { id, email } of a confirmed school account, or null. */
export async function schoolAccount(userId) {
  const { rows } = await pool.query('SELECT id, email, notifications FROM subscribers WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || user.notifications == null || user.notifications < 0) return null;
  const email = String(user.email || '').trim().toLowerCase();
  return email.endsWith(SCHOOL_DOMAIN) ? { id: user.id, email } : null;
}

/**
 * Sets req.schoolUser when the request carries a valid token of a confirmed school
 * account. No token → anonymous. An invalid/expired token is rejected (401,
 * code "token_invalid") so the client refreshes it instead of silently losing access.
 * Routes decide what to hide.
 */
export async function optionalSchoolUser(req, res, next) {
  req.schoolUser = null;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return next();
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token', code: 'token_invalid' });
  }
  try {
    req.schoolUser = await schoolAccount(payload.id);
  } catch {
    // DB unavailable: serve public data
  }
  next();
}
