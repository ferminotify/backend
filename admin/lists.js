// Lists on the admin pages: query string parsing, paged queries, CSV export.
// A list is { select, from, order, params }: data = SELECT select from ORDER BY order LIMIT/OFFSET,
// total = count(*) of the same rows. Filters go into `from` (WHERE/HAVING) with $n params only.

export const PER_PAGE = 50;

/** Date for CSV: Rome local 'YYYY-MM-DD HH:mm', '' when missing. */
export function csvDate(v) {
  if (!v) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const CSV_MAX = 50000;

/** One of the allowed values (compared as strings), else the default. */
export function pick(value, allowed, def) {
  const v = String(value ?? '');
  return allowed.map(String).includes(v) ? allowed.find((a) => String(a) === v) : def;
}

/** Free-text search, trimmed and capped; '' when missing. */
export const text = (value, max = 80) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** ILIKE pattern matching `q` anywhere, with % _ \ taken literally. */
export const like = (q) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export function pageNum(req) {
  const p = Number.parseInt(req.query.p, 10);
  return Number.isFinite(p) && p > 0 && p < 100000 ? p : 1;
}

/** Relative link to the current page with `changes` applied to its query string (empty values dropped). */
export function link(req, changes) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...req.query, ...changes })) {
    if (k === 'part') continue; // which piece assets/admin.js asked for, not a filter
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '?';
}

/**
 * The list sorted by the column the user clicked (?ord=key&dir=asc|desc), its own order after that.
 * cols: [{ key, sort: 'SQL expression' }]; only these expressions reach the SQL, never the query string.
 * Returns the list plus { ord, dir } (empty when the list keeps its own order).
 */
export function sorted(req, list, cols) {
  const col = cols.find((c) => c.sort && c.key === req.query.ord);
  if (!col) return { ...list, ord: '', dir: '' };
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  return { ...list, order: `${col.sort} ${dir.toUpperCase()} NULLS LAST, ${list.order}`, ord: col.key, dir };
}

/** Sort params to carry over in the filter forms. */
export const keepSort = (req) => ({ ord: req.query.ord, dir: req.query.dir });

/** Current page of the list and its total. */
export async function runList(db, req, { select, from, order, params = [] }) {
  const page = pageNum(req);
  const [{ rows }, { rows: [count] }] = await Promise.all([
    db.query(`SELECT ${select} ${from} ORDER BY ${order} LIMIT ${PER_PAGE} OFFSET ${(page - 1) * PER_PAGE}`, params),
    db.query(`SELECT count(*)::int AS n FROM (SELECT 1 ${from}) z`, params),
  ]);
  return { rows, total: count.n, page };
}

/** Whole list as CSV (Excel-friendly: BOM, semicolons). cols: [{ label, text: (row) => string }] */
export async function listCsv(db, { select, from, order, params = [] }, cols) {
  const { rows } = await db.query(`SELECT ${select} ${from} ORDER BY ${order} LIMIT ${CSV_MAX}`, params);
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => cell(c.label)).join(';'), ...rows.map((r) => cols.map((c) => cell(c.text(r))).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Response for ?format=csv: { csv: { filename, body } } (routes/admin.js sends it as a download). */
export async function csvResponse(db, list, cols, name) {
  const day = new Date().toISOString().slice(0, 10);
  return { csv: { filename: `fermi-notify-${name}-${day}.csv`, body: await listCsv(db, list, cols) } };
}
