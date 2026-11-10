// Panoramica: notifier health, subscribers and their channels, email open rate over 30 days, notifier cycles
// over 7 days. Queries from staging/metabase/pages.mjs; tables unqualified (search_path = ADMIN_DB_SCHEMA,
// routes/admin.js).
import { html, card, empty, rateLines, countBars, dataTable, num, pct, dayMonth, weekday, dateTime, ago } from './ui.js';

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
  (SELECT count(*) FROM logs_notifier WHERE type = 'error' AND timestamp >= now() - interval '24 hours')::int AS errori_24h,
  (SELECT max(timestamp) FROM logs_notifier WHERE type = 'success') AS ultimo_ciclo
FROM subscribers`;

/** One row per Rome calendar day, the last `days` up to today, zeros where nothing happened. */
const perDay = (days, table, col, aggs) => `
WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Rome')::date AS d),
days AS (SELECT (SELECT d FROM today) - g AS day FROM generate_series(0, ${days - 1}) g),
agg AS (SELECT (${col} AT TIME ZONE 'Europe/Rome')::date AS day, ${aggs.map(([name, expr]) => `${expr} AS ${name}`).join(', ')}
  FROM ${table} WHERE ${col} >= ((SELECT d FROM today) - ${days - 1})::timestamp AT TIME ZONE 'Europe/Rome' GROUP BY 1)
SELECT to_char(days.day, 'YYYY-MM-DD') AS iso, ${aggs.map(([name]) => `coalesce(${name}, 0)::int AS ${name}`).join(', ')}
FROM days LEFT JOIN agg USING (day) ORDER BY days.day`;

// Notification emails by kind, without Apple Mail: it downloads the image on delivery (privacy protection), so
// its "opens" are not readings. Same rule as "Tasso senza Apple" in metabase/pages.mjs.
const KINDS = [['daily', 'Giornaliera', 'c-data'], ['lastminute', 'Last minute', 'c-data2']];
const NO_APPLE = "via IS DISTINCT FROM 'apple'";
const OPENS = perDay(30, 'email_sends', 'sent_at', KINDS.flatMap(([k]) => [
  [`${k}_inviate`, `count(*) FILTER (WHERE kind = '${k}' AND ${NO_APPLE})`],
  [`${k}_aperte`, `count(opened_at) FILTER (WHERE kind = '${k}' AND ${NO_APPLE})`],
]));
const CYCLES = perDay(7, 'logs_notifier', 'timestamp',
  [['riusciti', "count(*) FILTER (WHERE type = 'success')"], ['errori', "count(*) FILTER (WHERE type = 'error')"]]);

/** Notifier state from its last successful cycle and the errors of the last 24 hours. */
function health(last, errors) {
  const stale = !last || Date.now() - last.getTime() > STALE_MIN * 60000;
  const [cls, state] = stale ? ['bad', 'Notifier fermo'] : errors ? ['warn', 'Notifier attivo, con errori'] : ['ok', 'Notifier attivo'];
  return html`<section class="health ${cls}" aria-label="Stato del notifier">
  <strong>${state}</strong>
  <span>Ultimo ciclo riuscito: ${last ? html`<b>${ago(last)}</b> (${dateTime(last)})` : html`<b>nessuno</b>`}</span>
  <span>Errori nelle ultime 24 ore: <b>${num(errors)}</b></span>
</section>`;
}

export async function panoramica(db) {
  const [{ rows: [s] }, { rows: opens }, { rows: cycles }] = await Promise.all([db.query(SUMMARY), db.query(OPENS), db.query(CYCLES)]);

  const people = card({
    title: 'Iscritti', cls: 'people',
    body: html`<p class="big">${num(s.attivi)}</p><p>confermati</p>
    <div class="split">
      <p><b>${num(s.da_confermare)}</b>da confermare</p>
      <p><b>${num(s.caselle_morte)}</b>casella email eliminata</p>
    </div>`,
  });

  const channel = (name, n) => html`<li>
    <span class="name">${name}</span><span class="n">${num(n)}<small>${pct(s.attivi ? n / s.attivi : null)}</small></span>
    <span class="meter" style="width:${s.attivi ? Math.min(100, (n / s.attivi) * 100).toFixed(1) : 0}%"></span>
  </li>`;
  const channels = card({
    title: 'Canali notifiche',
    body: html`<ul class="channels">${channel('Email', s.email)}${channel('Telegram', s.telegram)}${channel('Notifiche push', s.push)}</ul>`,
  });

  const sum = (col) => opens.reduce((acc, r) => acc + r[col], 0);
  const kinds = KINDS.map(([k, name, cls]) => ({ k, name, cls, sent: sum(`${k}_inviate`), opened: sum(`${k}_aperte`) }));
  const rateOf = (opened, sent) => (sent ? opened / sent : null);
  const dayText = (r) => kinds.map(({ k, name }) => (r[`${k}_inviate`]
    ? `${name} ${pct(rateOf(r[`${k}_aperte`], r[`${k}_inviate`]), 1)} (${num(r[`${k}_aperte`])} su ${num(r[`${k}_inviate`])})`
    : `${name}: nessun invio`)).join(', ');
  const rate = card({
    title: 'Aperture delle email, 30 giorni',
    sub: `Media: ${kinds.map(({ name, sent, opened }) => `${name.toLowerCase()} ${sent ? pct(opened / sent, 1) : '–'}`).join(', ')}`,
    body: kinds.some((kd) => kd.sent)
      ? html`${rateLines({
        label: `Tasso di apertura delle email negli ultimi 30 giorni, senza Apple Mail: ${kinds.map(({ name, sent, opened }) => `${name} ${pct(rateOf(opened, sent), 1)}`).join(', ')}`,
        days: opens.map((r) => r.iso),
        titles: opens.map((r) => `${dayMonth(r.iso)}: ${dayText(r)}`),
        series: kinds.map(({ k, name, cls }) => ({
          label: name, cls, values: opens.map((r) => rateOf(r[`${k}_aperte`], r[`${k}_inviate`])),
        })),
      })}
      <p class="note">Senza Apple Mail.</p>
      ${dataTable(['Giorno', ...kinds.flatMap(({ name }) => [`${name}, inviate`, 'Aperte', 'Tasso'])],
        opens.map((r) => [dayMonth(r.iso), ...kinds.flatMap(({ k }) => {
          const sent = r[`${k}_inviate`], opened = r[`${k}_aperte`];
          return [num(sent), num(opened), sent ? pct(opened / sent, 1) : '–'];
        })]).reverse())}`
      : empty('Nessuna email giornaliera o last minute inviata negli ultimi 30 giorni.'),
  });

  const total = cycles.reduce((a, r) => a + r.riusciti + r.errori, 0);
  const errors = cycles.reduce((a, r) => a + r.errori, 0);
  const notifier = card({
    title: 'Cicli del notifier, 7 giorni',
    sub: total ? (errors ? `${num(errors)} ${errors === 1 ? 'errore' : 'errori'} nella settimana` : 'Nessun errore nella settimana') : null,
    body: total
      ? html`${countBars({
        legendLabel: 'Cicli riusciti',
        label: `Cicli riusciti del notifier negli ultimi 7 giorni, ${num(errors)} errori`,
        bars: cycles.map((r) => ({
          iso: r.iso, value: r.riusciti,
          title: `${weekday(r.iso)}: ${num(r.riusciti)} riusciti, ${num(r.errori)} errori`,
          flag: r.errori ? `${num(r.errori)} ${r.errori === 1 ? 'errore' : 'errori'}` : null,
        })),
      })}
      ${dataTable(['Giorno', 'Riusciti', 'Errori'], cycles.map((r) => [weekday(r.iso), num(r.riusciti), num(r.errori)]).reverse())}`
      : empty('Nessun ciclo registrato negli ultimi 7 giorni.'),
  });

  return {
    title: 'Panoramica',
    body: html`${health(s.ultimo_ciclo && new Date(s.ultimo_ciclo), s.errori_24h)}
<div class="overview">${people}${channels}</div>
<div class="grid2">${rate}${notifier}</div>`,
  };
}
