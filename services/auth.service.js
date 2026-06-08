import bcrypt from 'bcrypt';
import subscriberRepo from '../repositories/subscriber.repository.js';
import { sendMailAsync } from '../utils/email.js';
import { passwordResetEmailHtml, passwordResetEmailText } from '../utils/emailTemplates.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { URL } from '../utils/config.js';
import logger from '../utils/logger.js';

const log = logger.child('auth-service');

function unsubscribeHeader({ id, unsub_token, email }) {
  return `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${id}&token=${unsub_token}&email=${email}>, <${URL}/auth/unsubscribe?id=${id}&token=${unsub_token}&email=${email}>`;
}

/**
 * Business logic for the password-reset flow. Transport-agnostic: returns
 * plain result objects; the route maps them to HTTP responses.
 */

/**
 * Generate a reset code, persist it, and email it.
 * @returns {{ ok: true } | { ok: false, reason: 'not_found' | 'no_name' | 'email_failed' }}
 */
export async function requestPasswordReset(email) {
  const user = await subscriberRepo.findByEmail(email);
  if (!user) return { ok: false, reason: 'not_found' };

  const name = user.name || '';
  if (!name) return { ok: false, reason: 'no_name' };

  // 6-char uppercase code (A-Z0-9), matching the previous inline style.
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  await subscriberRepo.setResetCode(email, code);

  try {
    await sendMailAsync(
      email,
      `Codice OTP [${code}]`,
      passwordResetEmailHtml({ safeName: escapeHtml(name), code, unsubInfo: { id: user.id, unsub_token: user.unsub_token }, email }),
      passwordResetEmailText({ name, code }),
      { 'List-Unsubscribe': unsubscribeHeader({ id: user.id, unsub_token: user.unsub_token, email }) }
    );
  } catch (mailErr) {
    log.error('ERR SEND RESET EMAIL', { email, error: mailErr.stack || mailErr });
    return { ok: false, reason: 'email_failed' };
  }

  return { ok: true };
}

/** Validate the OTP for a reset. Returns the repo status string ('OK', …). */
export function verifyResetOtp(email, otp) {
  return subscriberRepo.verifyOTP(email, otp);
}

/**
 * Set a new password after OTP validation.
 * @returns {{ ok: true } | { ok: false, otpError: string }}
 */
export async function setNewPassword(email, otp, newPassword) {
  const valid = await subscriberRepo.verifyOTP(email, otp);
  if (valid !== 'OK') return { ok: false, otpError: valid };

  const hashed = await bcrypt.hash(newPassword, 10);
  await subscriberRepo.updatePassword(email, hashed);
  return { ok: true };
}
