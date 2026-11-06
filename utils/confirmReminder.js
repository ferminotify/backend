// Accounts enter only once their email is confirmed (the link in the signup email).
// A login before that is refused, and the confirmation email sent again (not too often:
// the login form must not be usable to flood an inbox).
import pool from '../db.js';
import logger from './logger.js';
import { sendConfirmationEmail } from './email.js';

const log = logger.child('confirm-reminder');
const RESEND_EVERY_MS = 5 * 60 * 1000;
const sentAt = new Map(); // user id -> time

/** 403 "confirm your email first", resending the confirmation email at most every few minutes. */
export async function refuseUnconfirmed(res, userId) {
  try {
    const last = sentAt.get(userId) || 0;
    if (Date.now() - last > RESEND_EVERY_MS) {
      const { rows } = await pool.query('SELECT id, email, name, gender, telegram, unsub_token, school_username FROM subscribers WHERE id = $1', [userId]);
      const u = rows[0];
      if (u?.telegram) {
        await sendConfirmationEmail(u.email, {
          name: u.name,
          gender: u.gender,
          code: u.telegram,
          unsubInfo: { id: u.id, unsub_token: u.unsub_token },
          schoolUsername: u.school_username,
        });
        sentAt.set(userId, Date.now());
        if (sentAt.size > 5000) sentAt.delete(sentAt.keys().next().value);
      }
    }
  } catch (err) {
    log.error('Confirmation email resend failed', { id: userId, error: err.message });
  }
  return res.status(403).json({
    error: 'Conferma prima la tua email: ti abbiamo inviato il link (controlla anche lo SPAM).',
    code: 'email_unconfirmed',
  });
}
