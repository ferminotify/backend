// SQL pieces shared by the admin pages (from staging/metabase/pages.mjs). Tables unqualified: the admin pool's
// search_path is ADMIN_DB_SCHEMA (routes/admin.js).

export const ACTIVE = 'notifications >= 0';
export const CHANNEL = (p = '') => `CASE ${p}notification_preferences WHEN 3 THEN 'Email e Telegram' WHEN 2 THEN 'Solo email'
  WHEN 1 THEN 'Solo Telegram' ELSE 'Nessuno' END`;
// Dead mailboxes (docs/email-caselle-morte.md §4.3): confirmed = a second "does not exist" on the check. Alias s.
export const DEAD_STATE = `CASE WHEN (SELECT count(*) FROM email_bounces b WHERE b.sub_id = s.id AND b.status = 'unknown_user'
  AND b.at >= s.email_inactive_at) >= 2 THEN 'Confermata' ELSE 'In verifica' END`;
export const OTHER_CHANNEL = `CASE WHEN s.notification_preferences & 1 = 1 AND s.telegram IS NOT NULL THEN 'Telegram'
  WHEN EXISTS (SELECT 1 FROM push p WHERE p.sub_id = s.id AND p.send_push_with_notifications) THEN 'Push'
  ELSE 'Nessun canale' END`;
export const REJECTION = `CASE WHEN status = 'unknown_user' THEN 'Casella eliminata' WHEN status = 'suppressed' THEN 'Bloccata da Azure'
  WHEN reason ~* '5\\.2\\.1|disabled|suspend' THEN 'Account sospeso' WHEN reason ~* '5\\.2\\.2|quota|full' THEN 'Casella piena'
  WHEN reason ~* 'too old' THEN 'Consegna scaduta' ELSE 'Altro' END`;
export const NO_APPLE = "via IS DISTINCT FROM 'apple'";
export const KIND_LABEL = { daily: 'Giornaliera', lastminute: 'Last minute', 'promo-orario': 'Campagna Orario' };
export const VIA_LABEL = { gmail: 'Gmail', apple: 'Apple Mail', altro: 'Altro' };

/** Histogram over labeled buckets: [[sql condition, label], ...] in order, the last one is the rest. */
export const buckets = (expr, list) => ({
  label: `CASE ${list.slice(0, -1).map(([c, l]) => `WHEN ${expr} ${c} THEN '${l}'`).join(' ')} ELSE '${list.at(-1)[1]}' END`,
  order: `CASE ${list.slice(0, -1).map(([c], i) => `WHEN ${expr} ${c} THEN ${i}`).join(' ')} ELSE ${list.length - 1} END`,
  labels: list.map(([, l]) => l),
});

/** Rows of a bucket query ({ b, n }) in bucket order, zero for the empty ones. */
export const fillBuckets = (b, rows) => b.labels.map((l) => ({ label: l, n: rows.find((r) => r.b === l)?.n || 0 }));

/** One row per Rome calendar day, the last `days` up to today; aggs: [[name, expr]], zeros where nothing happened. */
export const perDay = (days, table, col, aggs, where = 'true') => `
WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Rome')::date AS d),
days AS (SELECT (SELECT d FROM today) - g AS day FROM generate_series(0, ${days - 1}) g),
agg AS (SELECT (${col} AT TIME ZONE 'Europe/Rome')::date AS day, ${aggs.map(([name, expr]) => `${expr} AS ${name}`).join(', ')}
  FROM ${table} WHERE ${col} >= ((SELECT d FROM today) - ${days - 1})::timestamp AT TIME ZONE 'Europe/Rome' AND (${where}) GROUP BY 1)
SELECT to_char(days.day, 'YYYY-MM-DD') AS iso, ${aggs.map(([name]) => `coalesce(${name}, 0)::int AS ${name}`).join(', ')}
FROM days LEFT JOIN agg USING (day) ORDER BY days.day`;

/** Same per week (Monday) or month, the last `count` up to the current one. `local`: Rome local timestamp expression. */
export const perPeriod = (unit, count, table, local, aggs, where = 'true') => `
WITH cur AS (SELECT date_trunc('${unit}', now() AT TIME ZONE 'Europe/Rome')::date AS d),
periods AS (SELECT ((SELECT d FROM cur) - g * interval '1 ${unit}')::date AS period FROM generate_series(0, ${count - 1}) g),
agg AS (SELECT date_trunc('${unit}', ${local})::date AS period, ${aggs.map(([name, expr]) => `${expr} AS ${name}`).join(', ')}
  FROM ${table} WHERE ${local} >= (SELECT d FROM cur) - ${count - 1} * interval '1 ${unit}' AND (${where}) GROUP BY 1)
SELECT to_char(periods.period, 'YYYY-MM-DD') AS iso, ${aggs.map(([name]) => `coalesce(${name}, 0)::int AS ${name}`).join(', ')}
FROM periods LEFT JOIN agg USING (period) ORDER BY periods.period`;
