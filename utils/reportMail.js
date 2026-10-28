// Delivery of user reports ("Segnala un problema") to the admin inbox.
//
// Preferred: the admin Gmail account sends to itself over SMTP with an App Password
// (GMAIL_USER + GMAIL_APP_PASSWORD), so reports do not use the Azure/Mailgun quota of
// the notification emails. Without it, falls back to the regular sender (no attachment).
import nodemailer from 'nodemailer';
import logger from './logger.js';
import { sendMailAsync } from './email.js';

const log = logger.child('report-mail');

const gmailUser = process.env.GMAIL_USER;
const gmailPass = process.env.GMAIL_APP_PASSWORD;
export const REPORT_EMAIL = process.env.REPORT_EMAIL || gmailUser || 'ferminotify@gmail.com';

let transport = null;
function gmailTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });
  }
  return transport;
}

/**
 * @param {{subject:string, html:string, text:string, replyTo?:string|null,
 *          attachments?: {filename:string, content:Buffer, contentType:string}[]}} mail
 * @returns {Promise<{via:'gmail'|'fallback'}>}  throws when the report could not be delivered
 */
export async function sendReportMail({ subject, html, text, replyTo, attachments = [] }) {
  let why = 'GMAIL_APP_PASSWORD non configurata';
  if (gmailUser && gmailPass) {
    try {
      await gmailTransport().sendMail({
        from: `Fermi Notify <${gmailUser}>`,
        to: REPORT_EMAIL,
        subject,
        html,
        text,
        replyTo: replyTo || undefined,
        attachments,
      });
      return { via: 'gmail' };
    } catch (err) {
      // Daily sending limit, revoked App Password, Gmail down: the report still goes out.
      log.error('Gmail report failed, using the regular sender', { error: err.message, code: err.responseCode });
      why = 'invio Gmail non riuscito';
    }
  }
  const contact = replyTo ? `<p>Rispondi a: ${replyTo.replace(/[<>&"']/g, '')}</p>` : '';
  const result = await sendMailAsync(
    REPORT_EMAIL,
    subject,
    `${html}${contact}${attachments.length ? `<p><i>Screenshot allegato non inviato (${why}).</i></p>` : ''}`,
    text
  );
  if (result?.skipped) throw new Error('No email transport configured');
  log.warn('Report sent without Gmail transport', { attachments: attachments.length });
  return { via: 'fallback' };
}
