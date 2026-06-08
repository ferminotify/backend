import { API_URL, URL } from './config.js';

/**
 * Pure HTML builders for transactional emails.
 *
 * Extracted verbatim from the inline strings in routes/auth.js so the rendered
 * output is byte-for-byte identical — only the duplication is removed. Callers
 * pass the already-escaped display name (`safeName`) plus the dynamic fields.
 */

/**
 * Registration confirmation email (used for both first send and resend).
 * @param {{ safeName: string, gender: string, confirmLink: string }} opts
 */
export function confirmationEmailHtml({ safeName, gender, confirmLink }) {
  const g = gender === 'M' ? 'o' : gender === 'F' ? 'a' : 'ə';
  return `<!doctype html><html><main style="font-family:Helvetica,Arial,Liberation Serif,sans-serif;background-color:#fff;color:#000"><table border=0 cellpadding=0 cellspacing=0 style="max-width:620px;border-collapse:collapse;margin:0 auto 0 auto;text-align:left;font-family:Helvetica,Arial,Liberation Serif,sans-serif"width=620px><tr style=background-color:#fff><td style="width:100%;padding:30px 7% 15px 7%"><a href=${URL}><img src=${API_URL}/email/v3/logo-long-allmuted-trasp.png style=width:70%;height:auto;color:#fff alt="FERMI NOTIFY"></a><tr style=background-color:#fff><td><table border=0 cellpadding=0 cellspacing=0 style="width:100%;background-color:#fff;padding:30px 7% 30px 7%;border:none;border-top:1px solid #ddd;border-bottom:1px solid #ddd;font-size:16px"><tr><td><h2 style="margin:10px 0">Ciao ${safeName}!</h2><tr><td style=text-align:left><p style=line-height:1.3>Per completare la registrazione, conferma il tuo indirizzo email:<tr><td style="padding:15px 0"><a href=${confirmLink} style="font-size:14px;letter-spacing:1.2px;padding:13px 17px;font-weight:600;background-color:#004a77;border-radius:10px;color:#fff;text-decoration:none"target=_blank>Conferma email</a><tr><td style=text-align:left><p style=line-height:1.3>Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo.<tr><td style=text-align:left><p style=line-height:1.3>A presto!</table><tr style=background-color:#fff><td style="padding:15px 7% 30px 7%;font-size:13px;position:relative;background-color:#fff"><p style=color:#8b959e>Il bottone non funziona? Conferma l'email attraverso il seguente link: <a href=${confirmLink} style=color:#004a77 target=_blank>${confirmLink}</a>.<p style=color:#8b959e>Per supporto o informazioni, consulta la <a href=${URL}/faq style=color:#004a77>FAQ</a> o contattaci su Instagram <a href=${URL}/ig style=color:#004a77><i>@ferminotify</i></a>.</p><a href=${URL}><img src=${API_URL}/email/v3/icon-allmuted.png style=height:35px;margin-bottom:5px alt="Fermi Notify"></a><p style=margin:0;color:#8b959e><i style=color:#8b959e>Fermi Notify Team</i><p style=margin-top:0><a href=${URL} style=color:#004a77 target=_blank>fn.lkev.in</a><p style=color:#8b959e;font-size:12px>Hai ricevuto questa email perché ti sei registrat${g} a <i>Fermi Notify</i>. Se non sei stato tu, ignora questa email.</table></main><html>`;
}

/** Plain-text fallback for the confirmation email. */
export function confirmationEmailText({ name, confirmLink }) {
  return `Ciao ${name}! Per completare la registrazione, conferma il tuo indirizzo email: ${confirmLink}. Appena completerai la registrazione, ti arriverà una seconda email con tutte le indicazioni sull'utilizzo. A presto!`;
}
