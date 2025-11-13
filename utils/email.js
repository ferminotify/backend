
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
	
    const poller = await EmailCl.beginSend(message);

    if (!poller.getOperationState().isStarted) {
      throw new Error("Poller was not started");
    }

    //let timeElapsed = 0;
    while(!poller.isDone()) {
      poller.poll();
      console.log("INFO Email send polling in progress");

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