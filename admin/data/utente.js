// Scheda utente (utente?id=N): profile, emails, rejections, push devices.
import { num, pct } from '../helpers/format.js';
import { runList, csvResponse, csvDate, sorted, PER_PAGE } from '../lists.js';
import { CHANNEL, DEAD_STATE, REJECTION, NO_APPLE, KIND_LABEL, VIA_LABEL } from '../sql.js';

const PROFILE = `SELECT s.id, s.name, s.surname, s.email, s.notifications, ${CHANNEL('s.')} AS canali, s.telegram IS NOT NULL AS telegram,
  array_to_string(s.tags, ', ') AS keyword, s.include_similar_tags, array_to_string(s.notify_optin, ', ') AS optin,
  to_char(s.notification_time, 'HH24:MI') AS ora, s.notification_day_before, s.last_login, s.profile_complete,
  s.school_username, s.email_inactive_at, s.email_inactive_reason,
  CASE WHEN s.email_inactive_at IS NOT NULL THEN ${DEAD_STATE} END AS stato_casella
  FROM subscribers s WHERE s.id = $1`;

// Cells: views/pages/utente/email-row.ejs, same order.
const EMAIL_COLS = [
  { label: 'Inviata', key: 'inviata', sort: 'sent_at', initial: 'desc', desc1: true, text: (r) => csvDate(r.sent_at) },
  { label: 'Tipo', key: 'tipo', sort: 'kind', text: (r) => KIND_LABEL[r.kind] || r.kind },
  { label: 'Aperta', key: 'aperta', sort: 'opened_at', desc1: true, text: (r) => csvDate(r.opened_at) },
  { label: 'Con', key: 'con', sort: 'via', text: (r) => VIA_LABEL[r.via] || '' },
];

const NOT_FOUND = { title: 'Utente non trovato', active: 'utenti', status: 404, view: 'pages/utente/not-found', locals: {} };

const listLocals = (es, page) => ({
  cols: EMAIL_COLS, ...page, ord: es.ord, dir: es.dir, perPage: PER_PAGE, emptyText: 'Nessuna email tracciata.',
  row: '/pages/utente/email-row', kinds: KIND_LABEL, vias: VIA_LABEL,
});

export async function utente(db, req) {
  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isSafeInteger(id) || id < 0) return NOT_FOUND;

  const emails = { select: 'sent_at, kind, opened_at, via', from: 'FROM email_sends WHERE sub_id = $1', order: 'sent_at DESC', params: [id] };
  const es = sorted(req, emails, EMAIL_COLS);
  if (req.query.format === 'csv') return csvResponse(db, es, EMAIL_COLS, `utente-${id}-email`);
  if (req.query.part === 'list') return { view: 'components/list', locals: listLocals(es, await runList(db, req, es)) };

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
  if (!u) return NOT_FOUND;

  return {
    title: `${u.name} ${u.surname}`,
    active: 'utenti',
    view: 'pages/utente/index',
    locals: {
      u,
      daily: u.ora ? `${u.ora}${u.notification_day_before ? ', il giorno prima' : ''}` : '–',
      summary: [
        { label: 'Notifiche ricevute', value: num(n.notifiche) },
        { label: 'Push ricevute', value: num(n.push) },
        { label: 'Email ricevute', value: num(e.inviate) },
        { label: 'Tasso di apertura', value: e.senza_apple ? pct(e.aperte / e.senza_apple, 0) : '–' },
      ],
      appleNote: e.apple ? `${num(e.apple)} aperte da Apple Mail, escluse dal tasso.` : null,
      bounces,
      devices,
      list: listLocals(es, page),
    },
  };
}
