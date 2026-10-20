// Gate for data the school only shows to its own users (teachers on the timetable):
// any confirmed Fermi Notify account. Without a Moodle session of their own, the data is
// fetched with the service account from the env (routes/timetable.js).
//
// The JWT alone is not enough: /login issues tokens to unconfirmed accounts too, so anyone
// could sign up with any address and read the teachers at once. The account is re-read from
// the DB and must be confirmed (notifications > -1; Google sign-ups are created confirmed,
// and only with a Google-verified email).
import jwt from 'jsonwebtoken';
import pool from '../db.js';

/** { id, email } of a confirmed account, or null. */
export async function confirmedAccount(userId) {
  const { rows } = await pool.query('SELECT id, email, notifications FROM subscribers WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || user.notifications == null || user.notifications < 0) return null;
  return { id: user.id, email: String(user.email || '').trim().toLowerCase() };
}

/**
 * Sets req.schoolUser when the request carries a valid token of a confirmed account. No token → anonymous. An invalid/expired token is rejected (401,
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
    req.schoolUser = await confirmedAccount(payload.id);
  } catch {
    // DB unavailable: serve public data
  }
  next();
}
