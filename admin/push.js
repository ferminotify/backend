// Push: devices registered for web push, by week, system and browser; list of devices.
import { html, region, card, stats, hBars, columns, filters, listView, badge, userLink, empty, num, dayMonth, dateTime } from './ui.js';
import { pick, text, like, link, runList, csvResponse, csvDate, sorted, keepSort, PER_PAGE } from './lists.js';
import { perPeriod } from './sql.js';

const OS = `CASE WHEN device_info ~* 'ios|iphone|ipad' THEN 'iOS' WHEN device_info ~* 'android' THEN 'Android'
  WHEN device_info ~* 'windows' THEN 'Windows' WHEN device_info ~* 'mac' THEN 'macOS' WHEN device_info ~* 'linux' THEN 'Linux' ELSE 'Altro' END`;
// device_info is "model · system version · browser" (frontend stores/push.js); users can rename it.
const BROWSER = `CASE WHEN device_info LIKE '%·%' THEN trim(regexp_replace(device_info, '^.*·', '')) ELSE 'Rinominato' END`;
const CON = [['', 'Tutti'], ['si', 'Sì'], ['no', 'No']];

const COLS = [
  { label: 'Registrato', key: 'registrato', sort: 'p.created_at', initial: 'desc', desc1: true, cell: (r) => (r.created_at ? dateTime(new Date(r.created_at)) : '–'), text: (r) => csvDate(r.created_at) },
  { label: 'Utente', key: 'utente', sort: 'lower(s.email)', cell: (r) => userLink(r.sub_id, r.email), text: (r) => r.email },
  { label: 'Dispositivo', key: 'dispositivo', sort: 'lower(p.device_info)', cell: (r) => r.device_info, text: (r) => r.device_info, wrap: true },
  { label: 'Con le notifiche', key: 'con', sort: 'p.send_push_with_notifications', cell: (r) => (r.send_push_with_notifications ? badge('Sì', 'ok') : badge('No')), text: (r) => (r.send_push_with_notifications ? 'Sì' : 'No') },
  { label: 'ID utente', key: 'id', sort: 'p.sub_id', num: true, cell: (r) => r.sub_id, text: (r) => r.sub_id },
];

function list(req) {
  const q = text(req.query.q);
  const con = pick(req.query.con, CON.map(([v]) => v), '');
  const where = [];
  const params = [];
  if (q) { params.push(like(q)); where.push('(s.email ILIKE $1 OR p.device_info ILIKE $1)'); }
  if (con) where.push(con === 'si' ? 'p.send_push_with_notifications' : 'NOT coalesce(p.send_push_with_notifications, false)');
  return { q, con, sql: {
    select: 'p.created_at, s.email, p.device_info, p.send_push_with_notifications, p.sub_id',
    from: `FROM push p JOIN subscribers s ON s.id = p.sub_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    order: 'p.created_at DESC NULLS LAST', params,
  } };
}

export async function push(db, req) {
  const l = list(req);
  const ls = sorted(req, l.sql, COLS);
  if (req.query.format === 'csv') return csvResponse(db, ls, COLS, 'dispositivi-push');
  const listBody = (page) => html`${filters({ fields: [
    { name: 'q', label: 'Cerca', value: l.q, placeholder: 'Email o dispositivo' },
    { name: 'con', label: 'Con le notifiche', value: l.con, options: CON },
  ], keep: keepSort(req) })}
  ${listView({ cols: COLS, ...page, ord: ls.ord, dir: ls.dir, perPage: PER_PAGE, link: (c) => link(req, c), emptyText: 'Nessun dispositivo con questi filtri.' })}`;
  if (req.query.part === 'list') return { fragment: listBody(await runList(db, req, ls)) };
  const q = (sql) => db.query(sql).then((r) => r.rows);
  const [[s], weekly, os, browser, page] = await Promise.all([
    q(`SELECT count(*)::int AS dispositivi, count(DISTINCT sub_id)::int AS utenti,
         count(*) FILTER (WHERE send_push_with_notifications)::int AS con, (SELECT count(*) FROM push_sent)::int AS inviate FROM push`),
    q(perPeriod('week', 16, 'push', "(created_at AT TIME ZONE 'Europe/Rome')", [['n', 'count(*)']])),
    q(`SELECT ${OS} AS label, count(*)::int AS n FROM push GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT ${BROWSER} AS label, count(*)::int AS n FROM push GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    runList(db, req, ls),
  ]);
  const bars = (rows, label) => (rows.length ? hBars({ label, rows: rows.map((r) => ({ label: r.label, value: r.n })) }) : empty('Nessun dispositivo.'));
  return {
    title: 'Push',
    body: html`${stats([
      { label: 'Dispositivi', value: num(s.dispositivi) },
      { label: 'Utenti con push', value: num(s.utenti) },
      { label: 'Dispositivi con le notifiche', value: num(s.con) },
      { label: 'Push inviate', value: num(s.inviate) },
    ])}
<div class="stack">${card({
  title: 'Registrati per settimana',
  body: weekly.some((r) => r.n) ? columns({
    label: 'Dispositivi registrati per settimana, ultime 16 settimane', every: 2, totals: true,
    series: [{ label: 'Dispositivi', cls: 'c-data' }],
    items: weekly.map((r) => ({ x: dayMonth(r.iso), parts: [r.n], title: `Settimana dal ${dayMonth(r.iso)}: ${num(r.n)}` })),
  }) : empty('Nessun dispositivo registrato nelle ultime 16 settimane.'),
})}</div>
<div class="grid2 stack">
  ${card({ title: 'Sistema', body: bars(os, 'Dispositivi per sistema') })}
  ${card({ title: 'Browser', body: bars(browser, 'Dispositivi per browser') })}
</div>
${card({ title: 'Dispositivi', body: region(listBody(page)) })}`,
  };
}
