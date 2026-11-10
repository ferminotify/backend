// Log: cycles and errors of the notifier and of the backup notifier; the two logs as one list.
import { html, region, card, stats, hBars, columns, filters, listView, badge, empty, num, dayMonth, weekday, dateTime, ago } from './ui.js';
import { pick, text, like, link, runList, csvResponse, csvDate, sorted, keepSort, PER_PAGE } from './lists.js';
import { perDay } from './sql.js';

const GIORNI = [[1, '24 ore'], [7, '7 giorni'], [30, '30 giorni']];
const SERVIZI = [['', 'Tutti'], ['notifier', 'Notifier'], ['riserva', 'Riserva']];
const ESITI = [['', 'Tutti'], ['error', 'Errori'], ['success', 'Riusciti'], ['info', 'Info']];
const TONE = { error: 'bad', success: 'ok' };
const ESITO = { error: 'Errore', success: 'Riuscito', info: 'Info' };

const COLS = [
  { label: 'Quando', key: 'quando', sort: 'timestamp', initial: 'desc', desc1: true, cell: (r) => dateTime(new Date(r.timestamp)), text: (r) => csvDate(r.timestamp) },
  { label: 'Servizio', key: 'servizio', sort: 'servizio', cell: (r) => r.servizio, text: (r) => r.servizio },
  { label: 'Esito', key: 'esito', sort: 'type', cell: (r) => badge(ESITO[r.type] || r.type, TONE[r.type] || ''), text: (r) => r.type },
  { label: 'Messaggio', key: 'messaggio', sort: 'message', cell: (r) => r.message || '', text: (r) => r.message || '', wrap: true },
];

function list(req, giorni) {
  const q = text(req.query.q, 120);
  const servizio = pick(req.query.servizio, SERVIZI.map(([v]) => v), '');
  const esito = pick(req.query.esito, ESITI.map(([v]) => v), '');
  const params = [];
  const where = [`timestamp >= now() - ${giorni} * interval '1 day'`];
  if (esito) { params.push(esito); where.push(`type = $${params.length}`); }
  if (q) { params.push(like(q)); where.push(`message ILIKE $${params.length}`); }
  const w = ` WHERE ${where.join(' AND ')}`;
  const parts = [];
  if (servizio !== 'riserva') parts.push(`SELECT timestamp, 'Notifier' AS servizio, type, message FROM logs_notifier${w}`);
  if (servizio !== 'notifier') parts.push(`SELECT timestamp, 'Riserva', type, message FROM logs_backup_notifier${w}`);
  return { q, servizio, esito, sql: { select: '*', from: `FROM (${parts.join(' UNION ALL ')}) l`, order: 'timestamp DESC', params } };
}

export async function log(db, req) {
  const giorni = pick(req.query.giorni, GIORNI.map(([v]) => v), 7);
  const l = list(req, giorni);
  const ls = sorted(req, l.sql, COLS);
  if (req.query.format === 'csv') return csvResponse(db, ls, COLS, 'log');
  const listBody = (page) => html`${filters({ fields: [
    { name: 'q', label: 'Cerca nel messaggio', value: l.q },
    { name: 'servizio', label: 'Servizio', value: l.servizio, options: SERVIZI },
    { name: 'esito', label: 'Esito', value: l.esito, options: ESITI },
  ], keep: { giorni: req.query.giorni, ...keepSort(req) } })}
  ${listView({ cols: COLS, ...page, ord: ls.ord, dir: ls.dir, perPage: PER_PAGE, link: (c) => link(req, c), emptyText: 'Nessuna riga con questi filtri.' })}`;
  if (req.query.part === 'list') return { fragment: listBody(await runList(db, req, ls)) };
  const W = `timestamp >= now() - ${giorni} * interval '1 day'`;
  const q = (sql) => db.query(sql).then((r) => r.rows);
  const chartDays = Math.max(giorni, 7);
  const [[s], daily, kinds, page] = await Promise.all([
    q(`SELECT (SELECT max(timestamp) FROM logs_notifier WHERE type = 'success') AS ultimo,
         (SELECT count(*) FROM logs_notifier WHERE type = 'error' AND ${W})::int AS errori,
         (SELECT count(*) FROM logs_notifier WHERE type = 'success' AND ${W})::int AS riusciti,
         (SELECT count(*) FROM logs_backup_notifier WHERE type = 'error' AND ${W})::int AS riserva`),
    q(perDay(chartDays, 'logs_notifier', 'timestamp', [['riusciti', "count(*) FILTER (WHERE type = 'success')"], ['errori', "count(*) FILTER (WHERE type = 'error')"]])),
    // Same error with different numbers or addresses = one kind: digits and emails replaced.
    q(`SELECT servizio || ': ' || left(regexp_replace(regexp_replace(message, '\\S+@\\S+', '<email>', 'g'), '[0-9]+', 'N', 'g'), 90) AS label,
         count(*)::int AS n
       FROM (SELECT 'Notifier' AS servizio, message FROM logs_notifier WHERE type = 'error' AND ${W}
             UNION ALL SELECT 'Riserva', message FROM logs_backup_notifier WHERE type = 'error' AND ${W}) x
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    runList(db, req, ls),
  ]);
  const last = s.ultimo && new Date(s.ultimo);
  const period = GIORNI.find(([v]) => v === giorni)[1];
  return {
    title: 'Log',
    body: html`${filters({ fields: [{ name: 'giorni', label: 'Periodo', value: giorni, options: GIORNI }],
      keep: { servizio: l.servizio, esito: l.esito, q: l.q, ...keepSort(req) } })}
${stats([
  { label: 'Ultimo ciclo riuscito', value: last ? ago(last) : 'Nessuno' },
  { label: `Errori, ${period}`, value: num(s.errori), tone: s.errori ? 'bad' : '' },
  { label: `Cicli riusciti, ${period}`, value: num(s.riusciti) },
  { label: `Allarmi della riserva, ${period}`, value: num(s.riserva), tone: s.riserva ? 'warn' : '' },
])}
<div class="grid2 stack">
  ${card({ title: `Cicli per giorno, ${chartDays} giorni`, body: daily.some((r) => r.riusciti + r.errori) ? columns({
    label: `Cicli del notifier per giorno, ultimi ${chartDays} giorni`, every: chartDays > 7 ? 7 : 1,
    series: [{ label: 'Riusciti', cls: 'c-gray' }, { label: 'Errori', cls: 'c-bad' }],
    items: daily.map((r) => ({
      x: chartDays > 7 ? dayMonth(r.iso) : weekday(r.iso), parts: [r.riusciti, r.errori],
      sub: chartDays <= 7 && r.errori ? `${num(r.errori)} err.` : null,
      title: `${dayMonth(r.iso)}: ${num(r.riusciti)} riusciti, ${num(r.errori)} errori`,
    })),
  }) : empty('Nessun ciclo nel periodo.') })}
  ${card({ title: 'Errori più frequenti', body: kinds.length ? hBars({
    label: 'Errori per tipo nel periodo', cls: 'c-bad', rows: kinds.map((r) => ({ label: r.label, value: r.n })),
  }) : empty('Nessun errore nel periodo.') })}
</div>
${card({ title: 'Log', body: region(listBody(page)) })}`,
  };
}
