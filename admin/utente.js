// Scheda utente (utente?id=N): profile, emails received, mail server rejections, push devices, notification counts.
// Linked from every list that shows a user.
import { html, region, card, stats, listView, badge, empty, num, pct, dateTime } from './ui.js';
import { link, runList, csvResponse, csvDate, sorted, PER_PAGE } from './lists.js';
import { CHANNEL, DEAD_STATE, REJECTION, NO_APPLE, KIND_LABEL, VIA_LABEL } from './sql.js';

const PROFILE = `SELECT s.id, s.name, s.surname, s.email, s.notifications, ${CHANNEL('s.')} AS canali, s.telegram IS NOT NULL AS telegram,
  array_to_string(s.tags, ', ') AS keyword, s.include_similar_tags, array_to_string(s.notify_optin, ', ') AS optin,
  to_char(s.notification_time, 'HH24:MI') AS ora, s.notification_day_before, s.last_login, s.profile_complete,
  s.school_username IS NOT NULL AS moodle, s.email_inactive_at, s.email_inactive_reason,
  CASE WHEN s.email_inactive_at IS NOT NULL THEN ${DEAD_STATE} END AS stato_casella
  FROM subscribers s WHERE s.id = $1`;

const EMAIL_COLS = [
  { label: 'Inviata', key: 'inviata', sort: 'sent_at', initial: 'desc', desc1: true, cell: (r) => dateTime(new Date(r.sent_at)), text: (r) => csvDate(r.sent_at) },
  { label: 'Tipo', key: 'tipo', sort: 'kind', cell: (r) => KIND_LABEL[r.kind] || r.kind, text: (r) => KIND_LABEL[r.kind] || r.kind },
  { label: 'Aperta', key: 'aperta', sort: 'opened_at', desc1: true, cell: (r) => (r.opened_at ? dateTime(new Date(r.opened_at)) : html`<span class="muted">No</span>`), text: (r) => csvDate(r.opened_at) },
  { label: 'Con', key: 'con', sort: 'via', cell: (r) => VIA_LABEL[r.via] || '–', text: (r) => VIA_LABEL[r.via] || '' },
];

const yes = (v) => (v ? 'Sì' : 'No');

export async function utente(db, req) {
  const id = Number.parseInt(req.query.id, 10);
  const notFound = { title: 'Utente non trovato', active: 'utenti', status: 404,
    body: html`<p><a href="utenti">Torna agli utenti</a></p>${empty('Nessun utente con questo ID.')}` };
  if (!Number.isSafeInteger(id) || id < 0) return notFound;

  const emails = { select: 'sent_at, kind, opened_at, via', from: 'FROM email_sends WHERE sub_id = $1', order: 'sent_at DESC', params: [id] };
  const es = sorted(req, emails, EMAIL_COLS);
  if (req.query.format === 'csv') return csvResponse(db, es, EMAIL_COLS, `utente-${id}-email`);
  const listBody = (page) => listView({ cols: EMAIL_COLS, ...page, ord: es.ord, dir: es.dir, perPage: PER_PAGE, link: (c) => link(req, c), emptyText: 'Nessuna email tracciata.' });
  if (req.query.part === 'list') return { fragment: listBody(await runList(db, req, es)) };

  const q = (sql) => db.query(sql, [id]).then((r) => r.rows);
  const [[u], [e], bounces, devices, [n], page] = await Promise.all([
    q(PROFILE),
    q(`SELECT count(*)::int AS inviate, count(*) FILTER (WHERE opened_at IS NOT NULL AND ${NO_APPLE})::int AS aperte,
         count(*) FILTER (WHERE ${NO_APPLE})::int AS senza_apple, count(*) FILTER (WHERE via = 'apple')::int AS apple,
         max(sent_at) AS ultima FROM email_sends WHERE sub_id = $1`),
    q(`SELECT at, ${REJECTION} AS tipo, reason FROM email_bounces WHERE sub_id = $1 ORDER BY at DESC LIMIT 20`),
    q('SELECT created_at, device_info, send_push_with_notifications FROM push WHERE sub_id = $1 ORDER BY created_at DESC NULLS LAST'),
    q('SELECT (SELECT count(*) FROM sent WHERE sub_id = $1)::int AS notifiche, (SELECT count(*) FROM push_sent WHERE sub_id = $1)::int AS push'),
    runList(db, req, es),
  ]);
  if (!u) return notFound;

  const giornaliera = u.ora ? `${u.ora}${u.notification_day_before ? ', il giorno prima' : ''}` : '–';
  const fact = (label, value) => html`<dt>${label}</dt><dd>${value}</dd>`;
  const profile = card({
    title: 'Profilo',
    body: html`<dl class="facts">
      ${fact('Canali', u.canali)}
      ${fact('Telegram', yes(u.telegram))}
      ${fact('Keyword', u.keyword || '–')}
      ${fact('Keyword simili', yes(u.include_similar_tags))}
      ${fact('Attività facoltative', u.optin || '–')}
      ${fact('Notifica giornaliera', giornaliera)}
      ${fact('Ultimo accesso', u.last_login ? dateTime(new Date(u.last_login)) : '–')}
      ${fact('Profilo completo', yes(u.profile_complete))}
      ${fact('Moodle', yes(u.moodle))}
      ${u.email_inactive_at ? html`${fact('Casella eliminata dal', dateTime(new Date(u.email_inactive_at)))}${fact('Motivo', u.email_inactive_reason || '–')}` : ''}
    </dl>`,
  });

  const bouncesCard = card({
    title: 'Rifiuti dei server di posta',
    body: bounces.length ? html`<div class="list"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Risposta</th></tr></thead><tbody>
      ${bounces.map((b) => html`<tr><td>${dateTime(new Date(b.at))}</td><td>${b.tipo}</td><td class="wrap">${b.reason || '–'}</td></tr>`)}
    </tbody></table></div>` : empty('Nessun rifiuto.'),
  });
  const devicesCard = card({
    title: 'Dispositivi push',
    body: devices.length ? html`<div class="list"><table><thead><tr><th>Registrato</th><th>Dispositivo</th><th>Notifiche</th></tr></thead><tbody>
      ${devices.map((d) => html`<tr><td>${d.created_at ? dateTime(new Date(d.created_at)) : '–'}</td><td class="wrap">${d.device_info}</td>
        <td>${d.send_push_with_notifications ? badge('Sì', 'ok') : badge('No')}</td></tr>`)}
    </tbody></table></div>` : empty('Nessun dispositivo.'),
  });

  return {
    title: `${u.name} ${u.surname}`,
    active: 'utenti',
    body: html`<p class="meta"><a href="utenti">Utenti</a><span>${u.email}</span><span>ID ${u.id}</span>
  ${u.notifications < 0 ? badge('Da confermare', 'warn') : badge('Attivo', 'ok')}
  ${u.stato_casella ? badge(`Casella eliminata, ${u.stato_casella.toLowerCase()}`, 'bad') : ''}</p>
${stats([
  { label: 'Notifiche ricevute', value: num(n.notifiche) },
  { label: 'Push ricevute', value: num(n.push) },
  { label: 'Email ricevute', value: num(e.inviate) },
  { label: 'Tasso di apertura', value: e.senza_apple ? pct(e.aperte / e.senza_apple, 0) : '–' },
])}
<div class="grid2 stack">${profile}${devicesCard}</div>
<div class="stack">${card({
  title: 'Email ricevute',
  sub: e.apple ? `${num(e.apple)} aperte da Apple Mail, escluse dal tasso.` : null,
  body: region(listBody(page)),
})}</div>
${bouncesCard}`,
  };
}
