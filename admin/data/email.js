// Email: open rates (docs/email-aperture.md), dead mailboxes (docs/email-caselle-morte.md); lists of sent emails,
// dead mailboxes and addresses that never open. Data only: views/pages/email/ draws it.
import { num, pct, dayMonth, weekday } from '../helpers/format.js';
import { pick, text, like, link, runList, csvResponse, csvDate, sorted, keepSort, PER_PAGE } from '../lists.js';
import { DEAD_STATE, OTHER_CHANNEL, REJECTION, NO_APPLE, KIND_LABEL, VIA_LABEL, buckets, fillBuckets, perDay, perPeriod } from '../sql.js';

const GIORNI = [[7, '7 giorni'], [30, '30 giorni'], [90, '90 giorni']];
const TIPI = [['', 'Tutti'], ...Object.entries(KIND_LABEL)];
const ELENCHI = [['inviate', 'Email inviate'], ['morte', 'Caselle morte'], ['mai-aperte', 'Mai aperte']];
const OPENED = `opened_at IS NOT NULL AND ${NO_APPLE}`;

const DELAY = buckets('m', [['< 60', 'Entro 1 ora'], ['< 360', '1-6 ore'], ['< 1440', '6-24 ore'], ['< 4320', '1-3 giorni'], ['', 'Oltre 3 giorni']]);
const RATE = buckets('r', [['= 0', '0%'], ['<= 0.25', '1-25%'], ['<= 0.5', '26-50%'], ['<= 0.75', '51-75%'], ['< 1', '76-99%'], ['', '100%']]);

function filtersOf(req) {
  const giorni = pick(req.query.giorni, GIORNI.map(([v]) => v), 30);
  const tipo = pick(req.query.tipo, TIPI.map(([v]) => v), '');
  // Inline: both come from the lists above. p = table alias prefix.
  const W = (p = '') => `${p}sent_at >= now() - ${giorni} * interval '1 day'${tipo ? ` AND ${p}kind = '${tipo}'` : ''}`;
  return { giorni, tipo, W };
}

// The three lists. cols: headings, sort keys and CSV text; the cells on the page: views/pages/email/row-<elenco>.ejs.
function list(req, { W }) {
  const elenco = pick(req.query.elenco, ELENCHI.map(([v]) => v), 'inviate');
  const q = text(req.query.q);
  const params = q ? [like(q)] : [];
  if (elenco === 'morte') {
    return { elenco, q, sql: {
      select: `s.id, s.email, ${DEAD_STATE} AS stato, ${OTHER_CHANNEL} AS altro, s.email_inactive_at AS dal, s.email_inactive_reason AS motivo`,
      from: `FROM subscribers s WHERE s.email_inactive_at IS NOT NULL${q ? ' AND s.email ILIKE $1' : ''}`,
      order: 's.email_inactive_at DESC', params,
    }, cols: [
      { label: 'Email', key: 'email', sort: 'lower(s.email)', text: (r) => r.email },
      { label: 'Stato', key: 'stato', sort: 'stato', text: (r) => r.stato },
      { label: 'Raggiungibile su', key: 'altro', sort: 'altro', text: (r) => r.altro },
      { label: 'Dal', key: 'dal', sort: 's.email_inactive_at', initial: 'desc', desc1: true, text: (r) => csvDate(r.dal) },
      { label: 'Motivo', key: 'motivo', sort: 's.email_inactive_reason', text: (r) => r.motivo || '' },
      { label: 'ID', key: 'id', sort: 's.id', num: true, text: (r) => r.id },
    ] };
  }
  if (elenco === 'mai-aperte') {
    // Hints only: active mailbox, at least 5 emails in 60 days, none opened, no rejection.
    return { elenco, q, sql: {
      select: `s.id, s.email, count(*)::int AS ricevute, EXISTS (SELECT 1 FROM unnest(s.tags) t WHERE t ~ '^5[A-Z]')
        AND NOT EXISTS (SELECT 1 FROM unnest(s.tags) t WHERE t ~ '^[1-4][A-Z]') AS solo_quinte`,
      from: `FROM email_sends e JOIN subscribers s ON s.id = e.sub_id
        WHERE e.sent_at >= now() - interval '60 days' AND s.notification_preferences & 2 = 2 AND s.email_inactive_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM email_bounces b WHERE b.sub_id = s.id)${q ? ' AND s.email ILIKE $1' : ''}
        GROUP BY s.id HAVING count(*) >= 5 AND count(e.opened_at) = 0`,
      order: 'solo_quinte DESC, ricevute DESC', params,
    }, cols: [
      { label: 'Email', key: 'email', sort: 'lower(s.email)', text: (r) => r.email },
      { label: 'Ricevute in 60 giorni', key: 'ricevute', sort: 'ricevute', num: true, text: (r) => r.ricevute },
      { label: 'Solo classi di quinta', key: 'quinte', sort: 'solo_quinte', initial: 'desc', text: (r) => (r.solo_quinte ? 'Sì' : 'No') },
      { label: 'ID', key: 'id', sort: 's.id', num: true, text: (r) => r.id },
    ] };
  }
  return { elenco, q, sql: {
    select: `e.sent_at, s.name || ' ' || s.surname AS utente, s.email, e.kind, e.opened_at, e.via, e.sub_id`,
    from: `FROM email_sends e JOIN subscribers s ON s.id = e.sub_id WHERE ${W('e.')}${q ? " AND (s.email ILIKE $1 OR s.name || ' ' || s.surname ILIKE $1)" : ''}`,
    order: 'e.sent_at DESC', params,
  }, cols: [
    { label: 'Inviata', key: 'inviata', sort: 'e.sent_at', initial: 'desc', desc1: true, text: (r) => csvDate(r.sent_at) },
    { label: 'Utente', key: 'utente', sort: "lower(s.name || ' ' || s.surname)", text: (r) => r.utente },
    { label: 'Email', key: 'email', sort: 'lower(s.email)', text: (r) => r.email },
    { label: 'Tipo', key: 'tipo', sort: 'e.kind', text: (r) => KIND_LABEL[r.kind] || r.kind },
    { label: 'Aperta', key: 'aperta', sort: 'e.opened_at', desc1: true, text: (r) => csvDate(r.opened_at) },
    { label: 'Con', key: 'con', sort: 'e.via', text: (r) => VIA_LABEL[r.via] || '' },
  ] };
}

const listLocals = (req, l, ls, page) => ({
  tabs: ELENCHI.map(([v, label]) => ({ href: link(req, { elenco: v, p: '', q: '', ord: '', dir: '' }), label, active: v === l.elenco })),
  filters: [{ name: 'q', label: 'Cerca', value: l.q, placeholder: l.elenco === 'inviate' ? 'Nome o email' : 'Email' }],
  keep: { giorni: req.query.giorni, tipo: req.query.tipo, elenco: req.query.elenco, ...keepSort(req) },
  elenco: l.elenco,
  list: { cols: l.cols, ...page, ord: ls.ord, dir: ls.dir, perPage: PER_PAGE, row: `/pages/email/row-${l.elenco}`, kinds: KIND_LABEL, vias: VIA_LABEL },
});

const bar = (r) => ({ label: r.label, value: r.n });

export async function email(db, req) {
  const f = filtersOf(req);
  const l = list(req, f);
  const ls = sorted(req, l.sql, l.cols);
  if (req.query.format === 'csv') return csvResponse(db, ls, l.cols, `email-${l.elenco}`);
  if (req.query.part === 'list') return { view: 'pages/email/list', locals: listLocals(req, l, ls, await runList(db, req, ls)) };
  const W = f.W();

  const q = (sql) => db.query(sql).then((r) => r.rows);
  const [[s], perDayRows, perKind, delay, hours, perUser, deadMonths, rejections, reach, page] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE ${OPENED})::numeric / NULLIF(count(*) FILTER (WHERE ${NO_APPLE}), 0) AS tasso,
         count(*)::int AS inviate, count(*) FILTER (WHERE via = 'apple')::int AS apple,
         (SELECT count(*) FROM subscribers WHERE email_inactive_at IS NOT NULL)::int AS morte
       FROM email_sends WHERE ${W}`),
    q(perDay(f.giorni, 'email_sends', 'sent_at', [
      ['aperte', `count(*) FILTER (WHERE ${OPENED})`], ['apple', "count(*) FILTER (WHERE via = 'apple')"], ['non_aperte', 'count(*) - count(opened_at)'],
    ], f.tipo ? `kind = '${f.tipo}'` : 'true')),
    q(`SELECT kind, count(*)::int AS inviate, count(*) FILTER (WHERE ${OPENED})::numeric / NULLIF(count(*) FILTER (WHERE ${NO_APPLE}), 0) AS tasso
       FROM email_sends WHERE ${W} GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT ${DELAY.label} AS b, count(*)::int AS n FROM (SELECT extract(epoch FROM opened_at - sent_at) / 60 AS m
       FROM email_sends WHERE ${OPENED} AND ${W}) x GROUP BY 1`),
    q(`SELECT extract(hour FROM opened_at AT TIME ZONE 'Europe/Rome')::int AS h, count(*)::int AS n
       FROM email_sends WHERE ${OPENED} AND ${W} GROUP BY 1`),
    q(`SELECT ${RATE.label} AS b, count(*)::int AS n FROM (SELECT count(*) FILTER (WHERE ${OPENED})::numeric / count(*) AS r
       FROM email_sends WHERE ${NO_APPLE} AND ${W} GROUP BY sub_id) x GROUP BY 1`),
    q(perPeriod('month', 12, 'subscribers s', "(s.email_inactive_at AT TIME ZONE 'Europe/Rome')", [
      ['confermate', `count(*) FILTER (WHERE ${DEAD_STATE} = 'Confermata')`], ['in_verifica', `count(*) FILTER (WHERE ${DEAD_STATE} = 'In verifica')`],
    ])),
    q(`SELECT ${REJECTION} AS label, count(*)::int AS n FROM email_bounces WHERE at >= now() - ${f.giorni} * interval '1 day' GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT ${OTHER_CHANNEL} AS label, count(*)::int AS n FROM subscribers s WHERE s.email_inactive_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    runList(db, req, ls),
  ]);

  const hourRows = Array.from({ length: 24 }, (_, h) => hours.find((r) => r.h === h)?.n || 0);
  const delayRows = fillBuckets(DELAY, delay);
  const userRows = fillBuckets(RATE, perUser);
  const month = (iso) => new Intl.DateTimeFormat('it-IT', { month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

  return {
    title: 'Email',
    view: 'pages/email/index',
    locals: {
      period: {
        fields: [{ name: 'giorni', label: 'Periodo', value: f.giorni, options: GIORNI }, { name: 'tipo', label: 'Tipo', value: f.tipo, options: TIPI }],
        keep: { elenco: req.query.elenco, q: l.q, ...keepSort(req) },
      },
      summary: [
        { label: 'Tasso di apertura', value: pct(Number(s.tasso), 1) },
        { label: 'Inviate', value: num(s.inviate) },
        { label: 'Apple Mail', value: num(s.apple) },
        { label: 'Caselle morte', value: num(s.morte), tone: s.morte ? 'bad' : '' },
      ],
      sentAny: s.inviate > 0,
      perDay: {
        label: `Email per giorno negli ultimi ${f.giorni} giorni`, every: f.giorni > 30 ? 14 : f.giorni > 7 ? 7 : 1,
        series: [{ label: 'Aperte', cls: 'c-data' }, { label: 'Apple Mail', cls: 'c-data2' }, { label: 'Non aperte', cls: 'c-gray' }],
        items: perDayRows.map((r) => ({
          x: f.giorni > 7 ? dayMonth(r.iso) : weekday(r.iso), parts: [r.aperte, r.apple, r.non_aperte],
          title: `${dayMonth(r.iso)}: ${num(r.aperte)} aperte, ${num(r.apple)} Apple Mail, ${num(r.non_aperte)} non aperte`,
        })),
      },
      perKind: perKind.map((r) => ({ label: KIND_LABEL[r.kind] || r.kind, value: Number(r.tasso) || 0, note: `${num(r.inviate)} inviate` })),
      delay: { any: delayRows.some((r) => r.n), rows: delayRows.map(bar) },
      perUser: { any: userRows.some((r) => r.n), rows: userRows.map(bar) },
      hours: {
        any: hourRows.some(Boolean),
        chart: {
          label: 'Aperture per ora del giorno', every: 3, series: [{ label: 'Aperture', cls: 'c-data' }],
          items: hourRows.map((n, h) => ({ x: `${h}`, parts: [n], title: `Ore ${h}: ${num(n)} aperture` })),
        },
      },
      deadMonths: {
        any: deadMonths.some((r) => r.confermate + r.in_verifica),
        chart: {
          label: 'Caselle disattivate per mese, ultimi 12 mesi', every: 2, totals: true,
          series: [{ label: 'Confermate', cls: 'c-bad' }, { label: 'In verifica', cls: 'c-soft' }],
          items: deadMonths.map((r) => ({
            x: month(r.iso), parts: [r.confermate, r.in_verifica],
            title: `${r.iso.slice(0, 7)}: ${num(r.confermate)} confermate, ${num(r.in_verifica)} in verifica`,
          })),
        },
      },
      rejections: rejections.map(bar),
      reach: reach.map(bar),
      ...listLocals(req, l, ls, page),
    },
  };
}
