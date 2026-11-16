// Panoramica: notifier health, subscribers and their channels, email open rate over 30 days, notifier cycles
// over 7 days. Data only: views/pages/panoramica/ draws it.
import { num, pct, dayMonth, weekday, dateTime, ago } from '../helpers/format.js';
import { perDay, cycleLog, CYCLE_AGGS } from '../sql.js';

const ACTIVE = 'notifications >= 0';
// The notifier sleeps 5 minutes after each cycle (notifier/main.py): no successful cycle for this long = stopped.
const STALE_MIN = 20;

const SUMMARY = `
SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS attivi,
  count(*) FILTER (WHERE notifications = -1)::int AS da_confermare,
  count(*) FILTER (WHERE ${ACTIVE} AND notification_preferences & 2 = 2 AND email_inactive_at IS NULL)::int AS email,
  count(*) FILTER (WHERE ${ACTIVE} AND notification_preferences & 1 = 1 AND telegram IS NOT NULL)::int AS telegram,
  (SELECT count(DISTINCT sub_id) FROM push WHERE send_push_with_notifications)::int AS push,
  count(*) FILTER (WHERE email_inactive_at IS NOT NULL)::int AS caselle_morte,
  (SELECT count(DISTINCT cycle) FILTER (WHERE type = 'error') FROM ${cycleLog("now() - interval '24 hours'")})::int AS errori_24h,
  (SELECT max(timestamp) FROM logs_notifier WHERE type = 'success') AS ultimo_ciclo
FROM subscribers`;

// Notification emails by kind, without Apple Mail: it downloads the image on delivery (privacy protection), so
// its "opens" are not readings.
const KINDS = [['daily', 'Giornaliera', 'c-data'], ['lastminute', 'Last minute', 'c-data2']];
const NO_APPLE = "via IS DISTINCT FROM 'apple'";
const OPENS = perDay(30, 'email_sends', 'sent_at', KINDS.flatMap(([k]) => [
  [`${k}_inviate`, `count(*) FILTER (WHERE kind = '${k}' AND ${NO_APPLE})`],
  [`${k}_aperte`, `count(opened_at) FILTER (WHERE kind = '${k}' AND ${NO_APPLE})`],
]));
const CYCLES = perDay(7, cycleLog("now() - interval '8 days'"), 'timestamp', CYCLE_AGGS);

/** Notifier state from its last successful cycle and the errors of the last 24 hours. */
function health(last, errors) {
  const stale = !last || Date.now() - last.getTime() > STALE_MIN * 60000;
  const [cls, state] = stale ? ['bad', 'Notifier fermo'] : errors ? ['warn', 'Notifier attivo, con errori'] : ['ok', 'Notifier attivo'];
  return { cls, state, ago: last && ago(last), at: last && dateTime(last), errors: num(errors) };
}

function emailRate(opens) {
  const sum = (col) => opens.reduce((acc, r) => acc + r[col], 0);
  const kinds = KINDS.map(([k, name, cls]) => ({ k, name, cls, sent: sum(`${k}_inviate`), opened: sum(`${k}_aperte`) }));
  const rateOf = (opened, sent) => (sent ? opened / sent : null);
  const dayText = (r) => kinds.map(({ k, name }) => (r[`${k}_inviate`]
    ? `${name} ${pct(rateOf(r[`${k}_aperte`], r[`${k}_inviate`]), 1)} (${num(r[`${k}_aperte`])} su ${num(r[`${k}_inviate`])})`
    : `${name}: nessun invio`)).join(', ');
  return {
    sub: `Media: ${kinds.map(({ name, sent, opened }) => `${name.toLowerCase()} ${sent ? pct(opened / sent, 1) : '–'}`).join(', ')}`,
    any: kinds.some((kd) => kd.sent),
    chart: {
      label: `Tasso di apertura delle email negli ultimi 30 giorni, senza Apple Mail: ${kinds.map(({ name, sent, opened }) => `${name} ${pct(rateOf(opened, sent), 1)}`).join(', ')}`,
      days: opens.map((r) => r.iso),
      titles: opens.map((r) => `${dayMonth(r.iso)}: ${dayText(r)}`),
      series: kinds.map(({ k, name, cls }) => ({ label: name, cls, values: opens.map((r) => rateOf(r[`${k}_aperte`], r[`${k}_inviate`])) })),
    },
    table: {
      cols: ['Giorno', ...kinds.flatMap(({ name }) => [`${name}, inviate`, 'Aperte', 'Tasso'])],
      rows: opens.map((r) => [dayMonth(r.iso), ...kinds.flatMap(({ k }) => {
        const sent = r[`${k}_inviate`], opened = r[`${k}_aperte`];
        return [num(sent), num(opened), sent ? pct(opened / sent, 1) : '–'];
      })]).reverse(),
    },
  };
}

function notifierCycles(cycles) {
  const total = cycles.reduce((a, r) => a + r.riusciti, 0);
  const errors = cycles.reduce((a, r) => a + r.con_errori, 0);
  return {
    sub: total ? (errors ? `${num(errors)} ${errors === 1 ? 'ciclo' : 'cicli'} con errori nella settimana` : 'Nessun errore nella settimana') : null,
    any: Boolean(total || errors),
    chart: {
      legendLabel: 'Cicli riusciti', flagLabel: 'Cicli con errori',
      label: `Cicli riusciti del notifier negli ultimi 7 giorni, ${num(errors)} con errori`,
      bars: cycles.map((r) => ({
        iso: r.iso, value: r.riusciti,
        title: `${weekday(r.iso)}: ${num(r.riusciti)} riusciti, ${num(r.con_errori)} con errori`,
        flag: r.con_errori ? num(r.con_errori) : null,
      })),
    },
    table: { cols: ['Giorno', 'Riusciti', 'Con errori'], rows: cycles.map((r) => [weekday(r.iso), num(r.riusciti), num(r.con_errori)]).reverse() },
  };
}

export async function panoramica(db) {
  const [{ rows: [s] }, { rows: opens }, { rows: cycles }] = await Promise.all([db.query(SUMMARY), db.query(OPENS), db.query(CYCLES)]);
  const channel = (name, n) => ({
    name, n: num(n), share: pct(s.attivi ? n / s.attivi : null),
    width: s.attivi ? Math.min(100, (n / s.attivi) * 100).toFixed(1) : 0,
  });
  return {
    title: 'Panoramica',
    view: 'pages/panoramica/index',
    locals: {
      health: health(s.ultimo_ciclo && new Date(s.ultimo_ciclo), s.errori_24h),
      people: { attivi: num(s.attivi), daConfermare: num(s.da_confermare), caselleMorte: num(s.caselle_morte) },
      channels: [channel('Email', s.email), channel('Telegram', s.telegram), channel('Notifiche push', s.push)],
      rate: emailRate(opens),
      cycles: notifierCycles(cycles),
    },
  };
}
