
import dotenv from 'dotenv';
dotenv.config();

import { EmailClient } from "@azure/communication-email";
const connectionString = process.env.AZURE_EMAIL_CONNECTION_STRING;
const EmailCl = new EmailClient(connectionString);

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
	
    if (!connectionString) {
      throw new Error('AZURE_EMAIL_CONNECTION_STRING is not set')
    }

    let poller
    try {
      poller = await EmailCl.beginSend(message);
    } catch (beginErr) {
      console.error('Email beginSend threw:', beginErr && beginErr.message ? beginErr.message : beginErr)
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
      console.log(`SUCCESS sent email (operation id: ${result.id}) to ${to}`);
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
    throw new Error('AZURE_EMAIL_CONNECTION_STRING is not set')
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
    // beginSend may throw quickly if credentials/sender are invalid.
    const poller = await EmailCl.beginSend(message)
    const opState = poller?.getOperationState && poller.getOperationState()
    // Return operationLocation or poller id so callers can track if needed.
    return { operationLocation: poller?.config?.operationLocation, opState }
  } catch (e) {
    console.error('sendMailAsync beginSend failed:', e && e.message ? e.message : e)
    throw new Error('Failed to start async email send: ' + (e && e.message ? e.message : e))
  }
}