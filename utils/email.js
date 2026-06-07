
import dotenv from 'dotenv';
import logger from './logger.js';
import { API_URL, URL } from './config.js';
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
  const g = gender === 'M' ? 'o' : gender === 'F' ? 'a' : 'ə';
  return sendMailAsync(
    email,
    `Welcome!`,
    `<!doctype html><main style="font-family:Helvetica,Arial,Liberation Serif,sans-serif;background-color:#fff;color:#000"><table border=0 cellpadding=0 cellspacing=0 style="max-width:620px;border-collapse:collapse;margin:0 auto 0 auto;text-align:left;font-family:Helvetica,Arial,Liberation Serif,sans-serif"width=620px><tr style=background-color:#fff><td style="width:100%;padding:30px 7% 15px 7%"><a href=${URL}><img src=${API_URL}/email/v3/logo-long-allmuted-trasp.png style=width:70%;height:auto;color:#fff alt="FERMI NOTIFY"></a><tr style=background-color:#fff><td><table border=0 cellpadding=0 cellspacing=0 style="width:100%;background-color:#fff;padding:30px 7% 30px 7%;border:none;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:16px"><tr><td><h2 style="margin:10px 0">Benvenut${g} a Fermi Notify!</h2><tr><td style=text-align:left><h4 style=margin-bottom:0>Ciao ${safeName}!</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Grazie per esserti registrat${g}, di seguito ci sono alcune indicazioni sul funzionamento di Fermi Notify.<h4 style=margin-bottom:0>Keyword</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Nella <a href=${URL}/dashboard style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>Dashboard</a> potrai inserire le tue <b>keyword</b>, necessarie per trovare le variazioni dell'orario che ti riguardano. Ti invitiamo ad aggiungere le parole che riconducono a te (il tuo cognome, la tua classe, i tuoi corsi, ecc...).<br>Presta attenzione alla <b>formattazione</b> delle keywords, dev'essere uguale a quella scritta nel calendario giornaliero (es. <i>4CIIN</i>, non "4 CIIN" o "4CIN")!<h4 style=margin-bottom:0>Notifiche</h4><p style=line-height:1.3;margin-top:10px;margin-bottom:10px>Vengono inviate notifiche sulle variazioni che contengono le tue keyword tramite email e/o Telegram. Puoi modificare le preferenze sulle notifiche nella <a href=${URL}/dashboard style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>Dashboard</a>.<ul style=padding-top:0;line-height:1.3;margin-top:0><li>Se c'è una variazione dell'orario, riceverai una notifica che riassume tutte le variazioni della giornata alle <b>6 del giorno stesso</b>.<li>Se viene pubblicata una variazione dell'orario poche ore prima che si verifichi (es. sostituzione dell'ultimo minuto), verrai notificat${g} <b>all'istante</b>.</ul><p style=margin-top:10px;margin-bottom:10px>Per maggiori informazioni, visita la <a href=${URL}/faq style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>FAQ</a>.</table><tr style=background-color:#fff><td style="padding:15px 7% 30px 7%;font-size:13px;position:relative;background-color:#fff"><p style=color:#8b959e>Per supporto o informazioni, consulta la <a href=${URL}/faq style=color:#004a77>FAQ</a> o contattaci su Instagram <a href=${URL}/ig style=color:#004a77><i>@ferminotify</i></a>.</p><a href=${URL}><img src=${API_URL}/email/v3/icon-allmuted.png style=height:35px;margin-bottom:5px alt="Fermi Notify"></a><p style=margin:0;color:#8b959e><i style=color:#8b959e>Fermi Notify Team</i><p style=margin-top:0><a href=${URL} style=color:#004a77 target=_blank>fn.lkev.in</a><p style=color:#8b959e;font-size:12px>Hai ricevuto questa email perché ti sei registrat${g} a Fermi Notify. Puoi disattivare le notifiche via mail <a href="${URL}/auth/unsubscribe?id=${unsubInfo.id}&token=${unsubInfo.unsub_token}&email=${email}" style="color:#004a77;text-decoration:none;border-bottom:1px solid #004a77"target=_blank>qui</a>.</table></main>`,
    `Ciao ${name}! Benvenuto a Fermi Notify! Esplora la Dashboard a ${URL}/dashboard per personalizzare le notifiche e visita ${URL}/faq per scoprire come funziona Fermi Notify.`,
    {
      'List-Unsubscribe': `<mailto:unsubscribe@fn.lkev.in?subject=Unsubscribe%20%3A%28&id=${unsubInfo.id}&token=${unsubInfo.unsub_token}&email=${email}>, <${URL}/auth/unsubscribe?id=${unsubInfo.id}&token=${unsubInfo.unsub_token}&email=${email}>`,
    }
  );
}

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
  if (!connectionString) {
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