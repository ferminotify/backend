
import dotenv from 'dotenv';
import logger from './logger.js';
dotenv.config();
const log = logger.child('email');

import { EmailClient } from "@azure/communication-email";
const connectionString = process.env.AZURE_EMAIL_CONNECTION_STRING;

function getEmailClient() {
  if (!connectionString) throw new Error('AZURE_EMAIL_CONNECTION_STRING is not set');
  return new EmailClient(connectionString);
}

export async function sendMail(to, subject, html, plainText, headers = {}) {
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