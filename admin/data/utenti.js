// Utenti: subscribers, channels, keywords, daily notification time, last logins; list of subscribers.
// Data only: views/pages/utenti/ draws it.
import { dayMonth, num } from '../helpers/format.js';
import { pick, text, like, runList, csvResponse, csvDate, sorted, keepSort, PER_PAGE } from '../lists.js';
import { ACTIVE, CHANNEL, perPeriod } from '../sql.js';

const SUMMARY = `SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS attivi, count(*) FILTER (WHERE notifications = -1)::int AS da_confermare,
  count(*) FILTER (WHERE NOT profile_complete)::int AS incompleti, count(*) FILTER (WHERE school_username IS NOT NULL)::int AS moodle
  FROM subscribers`;
const CHANNELS = `SELECT ${CHANNEL()} AS label, count(*)::int AS n FROM subscribers WHERE ${ACTIVE} GROUP BY 1 ORDER BY 2 DESC`;
const TAGS = `SELECT k AS label, count(*)::int AS n FROM subscribers, unnest(tags) k WHERE ${ACTIVE} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`;
const TIMES = `SELECT to_char(notification_time, 'HH24:MI') || CASE WHEN notification_day_before THEN ', giorno prima' ELSE '' END AS label,
  count(*)::int AS n FROM subscribers WHERE ${ACTIVE} AND notification_preferences > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;
const LOGINS = perPeriod('week', 12, 'subscribers', 'last_login', [['n', 'count(*)']]);

const STATI = [['', 'Tutti'], ['attivo', 'Attivi'], ['da_confermare', 'Da confermare']];
const CANALI = [['', 'Tutti'], ['3', 'Email e Telegram'], ['2', 'Solo email'], ['1', 'Solo Telegram'], ['0', 'Nessuno']];

function list(req) {
  const q = text(req.query.q);
  const stato = pick(req.query.stato, STATI.map(([v]) => v), '');
  const canali = pick(req.query.canali, CANALI.map(([v]) => v), '');
  const where = [];
  const params = [];
  if (q) {
    params.push(like(q));
    where.push(`(name || ' ' || surname ILIKE $1 OR email ILIKE $1 OR array_to_string(tags, ' ') ILIKE $1)`);
  }
  if (stato) where.push(stato === 'attivo' ? ACTIVE : 'notifications = -1');
  if (canali) where.push(`notification_preferences = ${Number(canali)}`);
  return {
    q, stato, canali,
    sql: {
      select: `id, name, surname, email, notifications, ${CHANNEL()} AS canali, email_inactive_at, telegram IS NOT NULL AS telegram,
        array_to_string(tags, ', ') AS keyword, to_char(notification_time, 'HH24:MI') || CASE WHEN notification_day_before THEN ', giorno prima' ELSE '' END AS giornaliera,
        last_login, school_username IS NOT NULL AS moodle`,
      from: `FROM subscribers${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      order: 'id DESC',
      params,
    },
  };
}

// Headings and sort keys (only these SQL expressions reach ORDER BY) and the CSV text of each column.
// The cells on the page: views/pages/utenti/row.ejs, same order.
const stato = (r) => (r.notifications < 0 ? 'Da confermare' : 'Attivo');
const COLS = [
  { label: 'ID', key: 'id', sort: 'id', initial: 'desc', num: true, text: (r) => r.id },
  { label: 'Nome', key: 'nome', sort: "lower(name || ' ' || surname)", text: (r) => `${r.name} ${r.surname}` },
  { label: 'Email', key: 'email', sort: 'lower(email)', text: (r) => r.email },
  { label: 'Stato', key: 'stato', sort: 'notifications < 0', text: stato },
  { label: 'Canali', key: 'canali', sort: 'notification_preferences', text: (r) => r.canali },
  { label: 'Keyword', key: 'keyword', sort: "lower(array_to_string(tags, ', '))", text: (r) => r.keyword },
  { label: 'Notifiche', key: 'notifiche', sort: 'notifications', num: true, text: (r) => Math.max(0, r.notifications) },
  { label: 'Giornaliera', key: 'giornaliera', sort: 'notification_time', text: (r) => r.giornaliera || '' },
  { label: 'Ultimo accesso', key: 'accesso', sort: 'last_login', desc1: true, text: (r) => csvDate(r.last_login) },
  { label: 'Moodle', key: 'moodle', sort: 'school_username IS NOT NULL', text: (r) => (r.moodle ? 'Sì' : 'No') },
];

/** Locals of views/pages/utenti/list.ejs: filters + one page of subscribers. */
const listLocals = (req, l, ls, page) => ({
  filters: [
    { name: 'q', label: 'Cerca', value: l.q, placeholder: 'Nome, email o keyword' },
    { name: 'stato', label: 'Stato', value: l.stato, options: STATI },
    { name: 'canali', label: 'Canali', value: l.canali, options: CANALI },
  ],
  keep: keepSort(req),
  list: { cols: COLS, ...page, ord: ls.ord, dir: ls.dir, perPage: PER_PAGE, emptyText: 'Nessun iscritto con questi filtri.', row: '/pages/utenti/row' },
});

const bar = (r) => ({ label: r.label, value: r.n });

export async function utenti(db, req) {
  const l = list(req);
  const ls = sorted(req, l.sql, COLS);
  if (req.query.format === 'csv') return csvResponse(db, ls, COLS, 'iscritti');
  if (req.query.part === 'list') return { view: 'pages/utenti/list', locals: listLocals(req, l, ls, await runList(db, req, ls)) };

  const [{ rows: [s] }, { rows: channels }, { rows: tags }, { rows: times }, { rows: logins }, page] = await Promise.all([
    db.query(SUMMARY), db.query(CHANNELS), db.query(TAGS), db.query(TIMES), db.query(LOGINS), runList(db, req, ls),
  ]);
  return {
    title: 'Utenti',
    view: 'pages/utenti/index',
    locals: {
      summary: [
        { label: 'Iscritti attivi', value: num(s.attivi) },
        { label: 'Da confermare', value: num(s.da_confermare) },
        { label: 'Profilo incompleto', value: num(s.incompleti) },
        { label: 'Con Moodle', value: num(s.moodle) },
      ],
      channels: channels.map(bar),
      tags: tags.map(bar),
      times: times.map(bar),
      logins: logins.map((r) => ({ x: dayMonth(r.iso), parts: [r.n], title: `Settimana dal ${dayMonth(r.iso)}: ${num(r.n)}` })),
      ...listLocals(req, l, ls, page),
    },
  };
}
