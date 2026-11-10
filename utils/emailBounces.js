// Dead mailboxes (docs/email-caselle-morte.md). The providers report rejections through webhooks
// (routes/hooks.js); every rejection goes to email_bounces, and only a deleted mailbox
// ("5.1.1", "user unknown"…) turns the email off: subscribers.email_inactive_at. The notifier
// then sends one check after 3 days (notifier/src/db.py email_check_due): delivered → back on.
import crypto from 'crypto';
import pool from '../db.js';
import logger from './logger.js';

const log = logger.child('email-bounces');

// The mailbox does not exist: deleted (school accounts after the diploma) or never existed.
const UNKNOWN_USER = /\b5\.1\.1\d?\b|does ?n[o']t exist|user unknown|unknown user|no such user|recipient ?not ?found|mailbox not found|no mailbox here/i;

/**
 * What a rejection means for the mailbox.
 * @param {string} reason the provider's text (SMTP reply)
 * @param {{ suppressed?: boolean, tooOld?: boolean }} [opts]
 *   suppressed: Azure did not even try (an earlier bounce); tooOld: Mailgun gave up retrying
 *   after hours of temporary errors: neither says the mailbox is gone.
 * @returns {'unknown_user' | 'failed' | 'suppressed'}
 */
export function bounceStatus(reason, { suppressed = false, tooOld = false } = {}) {
  if (suppressed) return 'suppressed';
  if (tooOld) return 'failed';
  return UNKNOWN_USER.test(String(reason || '')) ? 'unknown_user' : 'failed';
}

/** Constant-time string comparison (secrets in URLs and signatures). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Mailgun's webhook signature: HMAC-SHA256(signing key, timestamp + token), at most 5 minutes old.
 * @param {{ timestamp?: string, token?: string, signature?: string }} sig
 */
export function mailgunSignatureOk(sig, key, now = Date.now()) {
  if (!key || !sig?.timestamp || !sig?.token || !sig?.signature) return false;
  if (Math.abs(now / 1000 - Number(sig.timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', key).update(String(sig.timestamp) + String(sig.token)).digest('hex');
  return safeEqual(expected, sig.signature);
}

/**
 * Mailgun keeps a bounced address on its list and drops later emails to it without trying:
 * the check after 3 days would never be delivered. Removed on the first "mailbox deleted".
 * Only with MAILGUN_API_KEY and MAILGUN_DOMAIN (MAILGUN_API_BASE for the EU region).
 */
async function forgetMailgunBounce(email) {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!key || !domain) return;
  const base = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v3/${encodeURIComponent(domain)}/bounces/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}` },
    });
    if (!res.ok && res.status !== 404) log.warn('Mailgun bounce not removed', { status: res.status });
  } catch (err) {
    log.warn('Mailgun bounce not removed', { error: err.message });
  }
}

/**
 * A rejection: logged for every subscriber with that address, and the email turned off if the
 * mailbox was deleted (only the first time: the check after it keeps the date).
 * Addresses that are not subscribers (e.g. a promo to non-subscribers) are not stored.
 * @param {string} email
 * @param {'azure' | 'mailgun'} provider
 * @param {string} reason
 * @param {{ suppressed?: boolean, tooOld?: boolean }} [opts]
 * @returns {Promise<{ status: string, stored: number, deactivated: number }>}
 */
export async function recordBounce(email, provider, reason, opts = {}) {
  const status = bounceStatus(reason, opts);
  const text = String(reason || '').slice(0, 1000);
  const ins = await pool.query(
    `INSERT INTO email_bounces (sub_id, email, provider, status, reason)
     SELECT id, email, $2, $3, $4 FROM subscribers WHERE lower(email) = lower($1)
     RETURNING sub_id, at`,
    [email, provider, status, text]
  );
  let deactivated = 0;
  if (status === 'unknown_user' && ins.rowCount) {
    const upd = await pool.query(
      // The rejection's own time: the notifier counts the rejections from it on (email_check_due).
      `UPDATE subscribers SET email_inactive_at = $3, email_inactive_reason = $2
        WHERE id = ANY($1::bigint[]) AND email_inactive_at IS NULL
        RETURNING id`,
      [ins.rows.map((r) => r.sub_id), `${provider}: ${text}`.slice(0, 1000), ins.rows[0].at]
    );
    deactivated = upd.rowCount;
    if (provider === 'mailgun') await forgetMailgunBounce(email);
  }
  log.info('Email bounce', { provider, status, subscribers: ins.rowCount, deactivated, ids: ins.rows.map((r) => r.sub_id) });
  return { status, stored: ins.rowCount, deactivated };
}

/**
 * A delivered email: turns the email back on only if it is the check, i.e. an email sent after
 * the mailbox was turned off (a late report of an earlier email does not count).
 * @returns {Promise<number>} accounts turned back on
 */
export async function recordDelivered(email) {
  const { rows } = await pool.query(
    `UPDATE subscribers s SET email_inactive_at = NULL, email_inactive_reason = NULL
      WHERE lower(s.email) = lower($1) AND s.email_inactive_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM email_sends e WHERE e.sub_id = s.id AND e.sent_at > s.email_inactive_at)
      RETURNING s.id`,
    [email]
  );
  if (rows.length) log.info('Mailbox working again (check delivered)', { ids: rows.map((r) => r.id) });
  return rows.length;
}
