
import dotenv from 'dotenv';
import logger from './logger.js';
import { URL } from './config.js';
import { welcomeEmailHtml, welcomeEmailText } from './emailTemplates.js';
dotenv.config();
const log = logger.child('email');

/** Escape user-supplied strings before interpolating into HTML email templates. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send the branded "welcome" email to a freshly-activated account.
 * @param {string} email recipient
 * @param {{name:string, gender:string, unsubInfo:{id:number|string, unsub_token:string}}} opts
 */
export async function sendWelcomeEmail(email, { name, gender, unsubInfo }) {
  const safeName = escapeHtml(name);
  return sendMailAsync(
    email,
    `Welcome!`,
    welcomeEmailHtml({ safeName, gender, unsubInfo, email }),
    welcomeEmailText({ name }),
    {
      'List-Unsubscribe': `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${unsubInfo.id}&token=${unsubInfo.unsub_token}&email=${email}>, <${URL}/auth/unsubscribe?id=${unsubInfo.id}&token=${unsubInfo.unsub_token}&email=${email}>`,
    }
  );
}

import { EmailClient } from "@azure/communication-email";
import nodemailer from "nodemailer";
const connectionString = process.env.AZURE_EMAIL_CONNECTION_STRING;

function getEmailClient() {
  if (!connectionString) throw new Error('AZURE_EMAIL_CONNECTION_STRING is not set');
  return new EmailClient(connectionString);
}

// Dev/staging fallback: when Azure isn't configured but an SMTP host is
// (e.g. Mailpit), deliver there so emails can be inspected rendered.
const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 1025;

let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: false,   // Mailpit speaks plain SMTP
      ignoreTLS: true,
    });
  }
  return smtpTransport;
}

async function sendViaSmtp(to, subject, html, plainText, headers = {}) {
  const info = await getSmtpTransport().sendMail({
    from: 'Fermi Notify <donotreply@fn.lkev.in>',
    to,
    subject,
    html,
    text: plainText,
    headers,
  });
  log.info('Email delivered to SMTP catcher', { to, subject, messageId: info.messageId });
  return { smtp: true, messageId: info.messageId };
}

export async function sendMail(to, subject, html, plainText, headers = {}) {
  if (!connectionString && smtpHost) return sendViaSmtp(to, subject, html, plainText, headers);
  const POLLER_WAIT_TIME = 10;
  try {

    const message = {
      senderAddress: "<donotreply@fn.lkev.in>",
      // sender name

      content: {
        subject: subject,
        html: html,
        plainText: plainText
      },
      recipients: {
        to: [
          {
            address: to,
          },
        ],
      },
      headers: headers
    };
	
    let poller
    try {
      poller = await getEmailClient().beginSend(message);
    } catch (beginErr) {
      log.error('Email beginSend threw', { error: beginErr && beginErr.message ? beginErr.message : beginErr });
      throw new Error('Failed to start email send operation: ' + (beginErr && beginErr.message ? beginErr.message : beginErr))
    }

    const opState = poller?.getOperationState && poller.getOperationState()
    // Some SDK versions return a status field (e.g. 'running') instead of an isStarted boolean.
    const startedStatuses = new Set(['running', 'inProgress', 'started', 'succeeded'])
    const status = opState?.status
    const isStarted = !!(opState && (opState.isStarted || (typeof status === 'string' && startedStatuses.has(status))))

    if (!opState || !isStarted) {
      // Provide more helpful troubleshooting info
      const hint = 'Poller did not start. Check AZURE_EMAIL_CONNECTION_STRING, that senderAddress is allowed for your Azure Communication Service resource, and that the recipient address is valid/verified in your resource settings.'
      throw new Error('Poller was not started. ' + hint + ` Raw opState: ${JSON.stringify(opState)}`)
    }

    //let timeElapsed = 0;
    while(!poller.isDone()) {
      poller.poll();

      await new Promise(resolve => setTimeout(resolve, POLLER_WAIT_TIME * 1000));
      //timeElapsed += 10;

      /*if(timeElapsed > 18 * POLLER_WAIT_TIME) {
        throw "ERR Polling timed out.";
      }*/
    }

    const result = poller.getResult();
    if (!result) {
      throw new Error("Poller result is undefined");
    }

    if(result.status === "Succeeded") {
      log.info('SUCCESS sent email', { operationId: result.id, to });
    } else {
      throw new Error(result.error || "Email send failed");
    }
  } catch (e) {
    throw new Error("ERR: " + (e.message || e));
  }
}

// Non-blocking send: start the send operation but don't poll to completion.
// This is useful when the caller shouldn't be blocked by the long-running poller.
export async function sendMailAsync(to, subject, html, plainText, headers = {}) {
  if (!connectionString) {
    if (smtpHost) return sendViaSmtp(to, subject, html, plainText, headers);
    log.warn('No AZURE_EMAIL_CONNECTION_STRING — email skipped', { to, subject, plainText });
    return { skipped: true };
  }

  const message = {
    senderAddress: "<donotreply@fn.lkev.in>",
    content: {
      subject: subject,
      html: html,
      plainText: plainText
    },
    recipients: { to: [{ address: to }] },
    headers: headers
  }

  try {
    const poller = await getEmailClient().beginSend(message)
    const opState = poller?.getOperationState && poller.getOperationState()
    // Return operationLocation or poller id so callers can track if needed.
    return { operationLocation: poller?.config?.operationLocation, opState }
  } catch (e) {
    log.error('sendMailAsync beginSend failed', { error: e && e.message ? e.message : e });
    throw new Error('Failed to start async email send: ' + (e && e.message ? e.message : e))
  }
}