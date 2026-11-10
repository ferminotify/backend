// HTML for the admin pages (routes/admin.js): layout, panels and charts, all rendered on the server.
// No client JavaScript: charts are an SVG plot (stretched to the box) with HTML axis labels, so the text stays
// readable at any width. Every chart also has its numbers in a <details> table.
// Look: the Fermi Notify site's own (frontend/src/assets/css): Montserrat, brand blue #004a77, its dark palette.
import { readFileSync } from 'fs';

// ---- Escaping: html`` escapes every value unless it is raw() (or html`` itself), arrays are joined.
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const part = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
export const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));

// frontend/src/assets/icons/logo-long.svg (white + red dot, as on the site); white parts as currentColor = #fff.
const LOGO = readFileSync(new URL('./assets/logo.svg', import.meta.url), 'utf8').replace('<svg ', '<svg aria-hidden="true" ');

// ---- Formats (Italian, Rome time)
const TZ = 'Europe/Rome';
const NUM = new Intl.NumberFormat('it-IT', { useGrouping: 'always' }); // Italian skips the dot in 4 digits
export const num = (n) => NUM.format(Number(n) || 0);
export const pct = (x, digits = 0) =>
  x == null || !Number.isFinite(x) ? '–' : new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: digits }).format(x);
/** 'YYYY-MM-DD' (a calendar day, no time zone) → "3 nov" / "lun 3". */
const day = (iso, opts) => new Intl.DateTimeFormat('it-IT', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
export const dayMonth = (iso) => day(iso, { day: 'numeric', month: 'short' });
export const weekday = (iso) => day(iso, { weekday: 'short', day: 'numeric' });
const sameYear = (d) => d.getFullYear() === new Date().getFullYear();
export const dateTime = (d) => new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', ...(sameYear(d) ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', timeZone: TZ,
}).format(d);
export const date = (d) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }).format(d);
const REL = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
export function ago(d) {
  const min = Math.round((d.getTime() - Date.now()) / 60000);
  if (Math.abs(min) < 60) return REL.format(min, 'minute');
  if (Math.abs(min) < 48 * 60) return REL.format(Math.round(min / 60), 'hour');
  return REL.format(Math.round(min / 1440), 'day');
}

// ---- Pieces
/** A panel with a title, an optional line under it, and its content. */
export const card = ({ title, sub, body, cls = '' }) => html`<section class="card ${cls}">
  <header><h2>${title}</h2>${sub ? html`<p>${sub}</p>` : ''}</header>
  ${body}
</section>`;

/** In place of a chart when there is nothing to draw. */
export const empty = (text) => html`<p class="empty">${text}</p>`;

/** legend: [[label, cssClass, 'line'|'dash'|undefined]] */
const legend = (items) => html`<ul class="legend">${items.map(([l, c, kind]) => html`<li><i class="${c} ${kind || 'box'}"></i>${l}</li>`)}</ul>`;

/** Numbers behind a chart. cols: [header, ...], rows: [[cell, ...]] */
export const dataTable = (cols, rows) => html`<details><summary>Mostra i numeri</summary><div class="scroll"><table>
  <thead><tr>${cols.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i === 0 ? html`<th scope="row">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody>
</table></div></details>`;

/** Axis for counts: round step (about a quarter of the max, at least 1), top = first step over the max. */
function countAxis(max) {
  const rough = Math.max(1, max) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough));
  const steps = Math.max(1, Math.ceil(max / step));
  return { top: step * steps, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) };
}

/** Plot box: y labels on the left, SVG (viewBox 0..100 both ways, stretched), x labels under it. */
const frame = ({ ticks, top, fmt, svg, xLabels, overlay, label }) => html`<div class="chart" role="img" aria-label="${label}">
  <div class="y" aria-hidden="true">${ticks.map((t) => html`<span style="bottom:${(t / top) * 100}%">${fmt(t)}</span>`)}</div>
  <div class="plot">${overlay}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      ${ticks.map((t) => html`<line class="grid${t === 0 ? ' base' : ''}" x1="0" x2="100" y1="${100 - (t / top) * 100}" y2="${100 - (t / top) * 100}"/>`)}
      ${svg}
    </svg>
  </div>
  <div class="x" aria-hidden="true">${xLabels.map((l) => html`<span style="left:${l.at}%">${l.text}${l.sub ? html`<b>${l.sub}</b>` : ''}</span>`)}</div>
</div>`;

/**
 * Lines of rates (0..1), one point per day; null = no data that day (gap in the line).
 * days: ['YYYY-MM-DD'], series: [{ label, cls, values: [rate|null] }], titles: hover text per day,
 * every: x label every N days (from the last one).
 */
export function rateLines({ days, series, titles, every = 7, label }) {
  const n = days.length;
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => 100 - v * 100;
  const line = ({ cls, values }) => {
    const segments = [];
    let cur = [];
    values.forEach((v, i) => {
      if (v == null) { if (cur.length) segments.push(cur); cur = []; } else cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    });
    if (cur.length) segments.push(cur);
    return html`<g class="${cls}">${segments.map((sg) => html`<polyline class="line" points="${sg.join(' ')}"/>`)}
      ${values.map((v, i) => (v == null ? '' : html`<path class="dot" d="M${x(i).toFixed(2)} ${y(v).toFixed(2)}h0"/>`))}</g>`;
  };
  const svg = html`${series.map(line)}
    ${days.map((d, i) => html`<rect class="hit" x="${(i / n) * 100}" y="0" width="${100 / n}" height="100"><title>${titles[i]}</title></rect>`)}`;
  return html`${legend(series.map((sr) => [sr.label, sr.cls, 'line']))}${frame({
    ticks: [0, 0.25, 0.5, 0.75, 1], top: 1, fmt: (t) => pct(t), svg, label,
    xLabels: days.map((iso, i) => ({ i, iso })).filter(({ i }) => (n - 1 - i) % every === 0).map(({ i, iso }) => ({ at: x(i), text: dayMonth(iso) })),
  })}`;
}

/**
 * Bars of counts, one per day, value written above; `flag` = red note under the day label (e.g. errors).
 * bars: [{ iso, value, title, flag }]
 */
export function countBars({ bars, label, legendLabel }) {
  const n = bars.length;
  const { top, ticks } = countAxis(Math.max(0, ...bars.map((b) => b.value)));
  const w = (100 / n) * 0.56;
  const svg = html`${bars.map((b, i) => {
    const h = (b.value / top) * 100;
    return html`<rect class="bar" x="${(i / n) * 100 + (100 / n - w) / 2}" y="${100 - h}" width="${w}" height="${h}"><title>${b.title}</title></rect>`;
  })}`;
  // Errors: a red cap on the bar (fixed height, they are a handful against hundreds of cycles).
  const values = html`<div class="vals" aria-hidden="true">${bars.map((b, i) => html`
    ${b.flag ? html`<i class="cap" style="left:${((i + 0.5) / n) * 100}%;width:${w}%;bottom:${(b.value / top) * 100}%"></i>` : ''}
    <span style="left:${((i + 0.5) / n) * 100}%;bottom:${(b.value / top) * 100}%">${num(b.value)}</span>`)}</div>`;
  return html`${legend([[legendLabel, 'c-bar'], ...(bars.some((b) => b.flag) ? [['Errori nel giorno', 'c-bad']] : [])])}${frame({
    ticks, top, fmt: num, svg, overlay: values, label,
    xLabels: bars.map((b, i) => ({ at: ((i + 0.5) / n) * 100, text: weekday(b.iso), sub: b.flag })),
  })}`;
}

/** Row of headline numbers in one strip. items: [{ label, value, tone? ('bad'|'warn') }] */
export const stats = (items) => html`<dl class="stats">${items.map((it) => html`
  <div class="${it.tone || ''}"><dt>${it.label}</dt><dd>${it.value}</dd></div>`)}</dl>`;

/** Horizontal bars, longest first as given. rows: [{ label, value, note? }] */
export function hBars({ rows, cls = 'c-data', fmt = num, label }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<ol class="hbars ${cls}" aria-label="${label}">${rows.map((r) => html`<li>
    <span class="l">${r.label}</span><span class="v">${fmt(r.value)}${r.note ? html`<small>${r.note}</small>` : ''}</span>
    <span class="b" style="width:${Math.max(0.5, (r.value / max) * 100).toFixed(1)}%"></span></li>`)}</ol>`;
}

/**
 * Columns of counts, stacked when an item has several parts.
 * items: [{ x, sub?, parts: [n, ...], title }], series: [{ label, cls }] (one per part), every: x label every N items.
 */
export function columns({ items, series, label, every = 1, totals = false }) {
  const n = items.length;
  const sums = items.map((it) => it.parts.reduce((a, b) => a + b, 0));
  const { top, ticks } = countAxis(Math.max(0, ...sums));
  const slot = 100 / n;
  const w = slot * (n > 16 ? 0.72 : 0.58);
  const svg = html`${items.map((it, i) => {
    let acc = 0;
    return it.parts.map((v, j) => {
      const y0 = 100 - ((acc + v) / top) * 100;
      acc += v;
      return v ? html`<rect class="bar ${series[j].cls}" x="${i * slot + (slot - w) / 2}" y="${y0}" width="${w}" height="${(v / top) * 100}"/>` : '';
    });
  })}
  ${items.map((it, i) => html`<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="100"><title>${it.title}</title></rect>`)}`;
  const overlay = totals
    ? html`<div class="vals" aria-hidden="true">${items.map((it, i) => (sums[i] ? html`<span style="left:${(i + 0.5) * slot}%;bottom:${(sums[i] / top) * 100}%">${num(sums[i])}</span>` : ''))}</div>`
    : '';
  return html`${series.length > 1 ? legend(series.map((sr) => [sr.label, sr.cls])) : ''}${frame({
    ticks, top, fmt: num, svg, overlay, label,
    xLabels: items.map((it, i) => ({ i, it })).filter(({ i }) => (n - 1 - i) % every === 0)
      .map(({ i, it }) => ({ at: (i + 0.5) * slot, text: it.x, sub: it.sub })),
  })}`;
}

/** Link to the user's page (admin/utente.js). */
export const userLink = (id, label) => html`<a class="user" href="utente?id=${id}">${label}</a>`;

/** Part of the page that updates on its own (assets/admin.js fetches it with ?part=list). */
export const region = (content, name = 'list') => html`<div data-region="${name}">${content}</div>`;

/** Small state label. tone: 'ok' | 'bad' | 'warn' | '' */
export const badge = (label, tone = '') => html`<span class="badge ${tone}">${label}</span>`;

/** Links that switch a view of the page. items: [{ href, label, active }] */
export const tabs = (items) => html`<nav class="tabs" aria-label="Elenchi">${items.map((t) => html`<a href="${t.href}"${t.active ? raw(' aria-current="true"') : ''}>${t.label}</a>`)}</nav>`;

/**
 * GET form of filters, kept in the URL; no button: assets/admin.js applies them as they change (Enter without JS). fields: [{ name, label, value, options?: [[value, label]], placeholder? }]
 * (options = select, otherwise a search box); keep: other query params to carry over.
 */
export const filters = ({ fields, keep = {} }) => html`<form class="filters" method="get">
  ${Object.entries(keep).map(([k, v]) => (v ? html`<input type="hidden" name="${k}" value="${v}">` : ''))}
  ${fields.map((f) => (f.options
    ? html`<label><span>${f.label}</span><select name="${f.name}">${f.options.map(([v, l]) => html`<option value="${v}"${String(v) === String(f.value) ? raw(' selected') : ''}>${l}</option>`)}</select></label>`
    : html`<label class="grow"><span>${f.label}</span><input type="search" name="${f.name}" value="${f.value || ''}" placeholder="${f.placeholder || ''}" autocomplete="off"></label>`))}
</form>`;

/**
 * A page of a list. cols: [{ label, cell: (row) => value, num?, wrap?, key?, sort?, initial? }], link: (changes) => href.
 * Columns with `sort` have a clickable heading: ord/dir = the current sort (from lists.js sorted()); with none, the
 * column with `initial` ('asc'|'desc') is the list's own order. A click on the active column flips it; on another
 * one sorts ascending, descending first for numbers and dates (`num` or `desc1`).
 */
export function listView({ cols, rows, total, page, perPage, link, ord = '', dir = '', emptyText = 'Nessun risultato.' }) {
  if (!total) return empty(emptyText);
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const state = (c) => (ord ? (c.key === ord ? dir : '') : c.initial || '');
  const head = (c) => {
    const cls = c.num ? raw(' class="num"') : '';
    if (!c.sort) return html`<th scope="col"${cls}>${c.label}</th>`;
    const st = state(c);
    const next = st ? (st === 'asc' ? 'desc' : 'asc') : (c.num || c.desc1 ? 'desc' : 'asc');
    const aria = st === 'asc' ? 'ascending' : st === 'desc' ? 'descending' : 'none';
    return html`<th scope="col" aria-sort="${aria}"${cls}><a class="sort${st ? ` ${st}` : ''}" href="${link({ ord: c.key, dir: next, p: '' })}"
      title="Ordina per ${c.label.toLowerCase()}">${c.label}<i aria-hidden="true"></i></a></th>`;
  };
  return html`<div class="list"><table>
  <thead><tr>${cols.map(head)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${cols.map((c) => html`<td${c.num ? raw(' class="num"') : c.wrap ? raw(' class="wrap"') : ''}>${c.cell(r)}</td>`)}</tr>`)}</tbody>
</table></div>
<div class="pager">
  <span>${num(from)}-${num(to)} di ${num(total)}</span>
  <span class="links">
    ${page > 1 ? html`<a href="${link({ p: page - 1 })}">Precedenti</a>` : ''}
    ${to < total ? html`<a href="${link({ p: page + 1 })}">Successivi</a>` : ''}
    <a href="${link({ format: 'csv', p: '' })}">Scarica CSV</a>
  </span>
</div>`;
}

// ---- Page
export const PAGES = [
  ['./', 'Panoramica'], ['utenti', 'Utenti'], ['email', 'Email'], ['notifiche', 'Notifiche'], ['push', 'Push'], ['log', 'Log'],
];

/** ready: hrefs of the pages that exist (the others are shown, greyed out). */
export function layout({ title, active, body, note, ready }) {
  const now = new Date();
  const fmt = (opts) => new Intl.DateTimeFormat('it-IT', { ...opts, timeZone: TZ }).format(now);
  return String(html`<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title} · Admin Fermi Notify</title>
<link rel="preload" href="assets/montserrat.woff2" as="font" type="font/woff2" crossorigin>
<style>${raw(CSS)}</style>
<script src="assets/admin.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="./" aria-label="Fermi Notify">${raw(LOGO)}<span>Admin</span></a>
  <nav aria-label="Sezioni">${PAGES.map(([href, name]) => (ready.includes(href)
    ? html`<a href="${href}"${href === active ? raw(' aria-current="page"') : ''}>${name}</a>`
    : html`<span class="soon" aria-disabled="true" title="In arrivo">${name}</span>`))}</nav>
</header>
${note ? html`<p class="banner">${note}</p>` : ''}
<main>
<h1>${title}</h1>
<div data-region="main">${body}</div>
</main>
<footer>Dati letti alle ${fmt({ hour: '2-digit', minute: '2-digit' })} del ${fmt({ day: 'numeric', month: 'long' })}.</footer>
</body>
</html>`);
}

const CSS = `
@font-face{font-family:Montserrat;font-style:normal;font-weight:400 800;font-display:swap;src:url(assets/montserrat.woff2) format("woff2")}
:root{
--bg:#f2f4f7;--surface:#fff;--surface-2:#f6f8fa;--text:#14202b;--muted:#53636f;--border:#dbe2e8;--grid:#e9eef2;
--accent:#004a77;--accent-soft:#d6e6f2;--data:#004a77;--data-2:#c4621a;--data-soft:#8fb3cf;--bar:#b4c6d4;
--ok:#2e7d32;--warn:#8a5a00;--warn-bg:#fff3d6;--bad:#c42b2b;--bad-bg:#fdeceb;
--banner:#fff3d6;--banner-text:#5f4700;--radius:12px;--header:#004a77;--header-border:#004a77}
@media (prefers-color-scheme:dark){:root{
--bg:#141314;--surface:#1c1b1d;--surface-2:#232125;--text:#e3e3e3;--muted:#b3b7b5;--border:#2f2d31;--grid:#29272b;
--accent:#c2e7ff;--accent-soft:#1f3442;--data:#71bdec;--data-2:#f2a65a;--data-soft:#3d6d8f;--bar:#46525d;
--ok:#81c784;--warn:#f9c74f;--warn-bg:#2f2810;--bad:#f2b8b5;--bad-bg:#3b1f1f;
--banner:#2f2810;--banner-text:#e6c46a;--header:#1c1b1d;--header-border:#2f2d31}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scrollbar-color:var(--bar) transparent}
body{margin:0;background:var(--bg);color:var(--text);font:400 15px/1.5 Montserrat,system-ui,sans-serif;font-variant-numeric:tabular-nums}
::selection{background:var(--accent-soft);color:var(--text)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
a{color:var(--accent)}
code{font:500 .9em ui-monospace,SFMono-Regular,Menlo,monospace}

.top{background:var(--header);border-bottom:1px solid var(--header-border);padding:0 24px;display:flex;flex-wrap:wrap;align-items:center;column-gap:32px}
.brand{display:flex;align-items:center;gap:12px;padding:14px 0;color:#fff;text-decoration:none}
.brand svg{height:22px;width:auto;display:block}
.brand span{color:rgba(255,255,255,.72);font-size:13px;font-weight:600;padding-left:12px;border-left:1px solid rgba(255,255,255,.25);line-height:20px}
.top nav{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.top nav a,.top nav span{padding:15px 10px 13px;white-space:nowrap;font-size:14px;font-weight:500;text-decoration:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.top nav a{color:rgba(255,255,255,.8)}.top nav a:hover{color:#fff;border-bottom-color:rgba(255,255,255,.35)}
.top nav a[aria-current]{color:#fff;border-bottom-color:#fff;font-weight:650}
.top nav .soon{color:rgba(255,255,255,.45);cursor:not-allowed}
.top :focus-visible{outline-color:#fff}
.banner{margin:0;padding:9px 24px;background:var(--banner);color:var(--banner-text);font-size:13px;font-weight:500}

main{max-width:1120px;margin:0 auto;padding:28px 24px 8px}
h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 18px}
h2{font-size:15px;font-weight:650;margin:0;letter-spacing:-.005em}

.health{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding:12px 16px;border-radius:var(--radius);margin-bottom:16px;
  background:var(--surface);border:1px solid var(--border);font-size:14px}
.health strong{display:flex;align-items:center;gap:8px;font-weight:650}
.health strong::before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor;flex:none}
.health.ok strong{color:var(--ok)}
.health.warn{background:var(--warn-bg);border-color:transparent}.health.warn strong{color:var(--warn)}
.health.bad{background:var(--bad-bg);border-color:transparent}.health.bad strong{color:var(--bad)}
.health span{color:var(--muted)}.health span b{color:var(--text);font-weight:600}

.overview{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:16px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px 14px;min-width:0}
.card.people{display:flex;flex-direction:column}.card.people .split{margin-top:auto}
.card.people .big+p{margin-bottom:22px}
.card>header{margin-bottom:14px}
.card>header p{margin:3px 0 0;font-size:13px;color:var(--muted)}
.big{font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1;margin:0}
.big+p{margin:6px 0 0;color:var(--muted);font-size:14px}
.split{display:flex;gap:28px;margin-top:22px;padding-top:14px;border-top:1px solid var(--border)}
.split p{margin:0;font-size:13px;color:var(--muted)}.split b{display:block;font-size:20px;font-weight:650;color:var(--text);letter-spacing:-.01em}
.channels{list-style:none;margin:0;padding:0;display:grid;gap:16px}
.channels li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;row-gap:6px}
.channels .name{font-weight:600}
.channels .n{font-size:20px;font-weight:650;letter-spacing:-.01em}.channels .n small{font-size:13px;font-weight:500;color:var(--muted);margin-left:8px}
.channels .meter{grid-column:1/-1;height:6px;border-radius:3px;background:var(--data);min-width:3px}
.foot{margin:16px 0 0;font-size:12.5px;color:var(--muted)}

.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:16px}
.legend{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--muted)}
.legend i{display:inline-block;margin-right:6px;vertical-align:middle}
.legend .box{width:10px;height:10px;border-radius:2px;background:var(--c)}
.legend .line{width:14px;height:2.5px;border-radius:2px;background:var(--c)}
.legend .dash{width:14px;height:0;border-top:2px dashed var(--c)}
.chart{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:190px auto;column-gap:10px;padding-top:6px}
.y{position:relative;min-width:30px;font-size:11.5px;color:var(--muted)}
.y span{position:absolute;right:0;transform:translateY(50%);line-height:1}
.plot{position:relative}
.plot svg{display:block;width:100%;height:100%;overflow:visible}
.x{grid-column:2;position:relative;height:34px;font-size:11.5px;color:var(--muted)}
.x span{position:absolute;top:7px;transform:translateX(-50%);white-space:nowrap;text-align:center;line-height:1.3}
.x b{display:block;color:var(--bad);font-weight:650}
.vals{position:absolute;inset:0;pointer-events:none}
.vals .cap{position:absolute;height:5px;transform:translateX(-50%);background:var(--bad);border-radius:2px 2px 0 0}
.vals .cap+span{transform:translate(-50%,-10px)}
.vals span{position:absolute;transform:translate(-50%,-5px);font-size:11.5px;font-weight:500;color:var(--muted);line-height:1}
line.grid{stroke:var(--grid);stroke-width:1;vector-effect:non-scaling-stroke}
line.grid.base{stroke:var(--border)}
.line{fill:none;stroke:var(--c);stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.dot{stroke:var(--c);stroke-width:6;stroke-linecap:round;vector-effect:non-scaling-stroke}
.bar{fill:var(--c,var(--bar))}.c-gray{--c:var(--bar)}
.hit{fill:transparent}.hit:hover{fill:var(--grid);fill-opacity:.6}
.c-data{--c:var(--data)}.c-data2{--c:var(--data-2)}.c-soft{--c:var(--data-soft)}.c-bar{--c:var(--bar)}.c-bad{--c:var(--bad)}.c-muted{--c:var(--muted)}
.note{font-size:12.5px;color:var(--muted);margin:6px 0 0}
.empty{margin:0;padding:48px 16px;text-align:center;color:var(--muted);font-size:14px;background:var(--surface-2);border-radius:8px}

details{margin-top:10px;border-top:1px solid var(--border);padding-top:6px;font-size:13px}
summary{cursor:pointer;color:var(--muted);font-weight:500;padding:4px 0;width:max-content;list-style:none;display:flex;align-items:center;gap:8px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
details[open] summary::before{transform:rotate(45deg) translate(-2px,-1px)}
summary:hover{color:var(--text)}
.scroll{overflow:auto;max-height:300px;margin-top:6px}
table{border-collapse:collapse;width:100%}
th,td{text-align:right;padding:5px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}
th:first-child{text-align:left;font-weight:500}
thead th{font-weight:600;color:var(--muted);position:sticky;top:0;background:var(--surface);border-bottom-color:var(--border)}
.error{background:var(--bad-bg);color:var(--text);border-radius:var(--radius);padding:16px 18px}
footer{max-width:1120px;margin:0 auto;padding:20px 24px 28px;color:var(--muted);font-size:12.5px}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;margin:0 0 16px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.stats>div{background:var(--surface);padding:14px 18px}
.stats dt{font-size:13px;color:var(--muted)}
.stats dd{margin:2px 0 0;font-size:26px;font-weight:700;letter-spacing:-.02em}
.stats .bad dd{color:var(--bad)}.stats .warn dd{color:var(--warn)}
.hbars{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.hbars li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;row-gap:5px;column-gap:12px;font-size:14px}
.hbars .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbars .v{font-weight:650}.hbars .v small{font-weight:500;color:var(--muted);margin-left:6px;font-size:12.5px}
.hbars .b{grid-column:1/-1;height:5px;border-radius:3px;background:var(--c)}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
.stack{display:grid;gap:16px;margin-bottom:16px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.badge.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent)}
.badge.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}
.badge.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.tabs a{padding:6px 14px;border-radius:999px;font-size:13.5px;font-weight:600;color:var(--muted);text-decoration:none;background:var(--surface-2);transition:color .15s,background .15s}
.tabs a:hover{color:var(--text)}
.tabs a[aria-current]{background:var(--accent);color:var(--surface)}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 12px;margin:0 0 14px}
.filters label{display:grid;gap:4px;font-size:12.5px;font-weight:600;color:var(--muted)}
.filters .grow{flex:1 1 220px}
.filters input,.filters select{font:inherit;font-size:14px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 10px;min-height:38px}
.filters input:focus-visible,.filters select:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
.list{overflow-x:auto;border:1px solid var(--border);border-radius:8px}
[aria-busy="true"] :is(.list,.pager,.empty,.stats,.stack,.grid2,.grid3){opacity:.5;transition:opacity .15s .12s}
.list table{font-size:13.5px}
.list th,.list td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--grid)}
.list thead th{background:var(--surface-2);font-size:12.5px}
.list tbody tr:last-child td{border-bottom:0}
.list tbody tr:hover td{background:var(--surface-2)}
.list .num{text-align:right}
.list th a.sort{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.list th.num a.sort{flex-direction:row-reverse}
.list th a.sort:hover{color:var(--text)}
.list th a.sort i{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:0;transition:opacity .15s,transform .15s}
.list th a.sort:hover i{opacity:.35}
.list th a.sort.asc,.list th a.sort.desc{color:var(--text)}
.list th a.sort.asc i,.list th a.sort.desc i{opacity:1}
.list th a.sort.asc i{transform:rotate(180deg)}
.list td.wrap{white-space:normal;min-width:280px;max-width:640px;overflow-wrap:anywhere}
.pager{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;margin-top:10px;font-size:13px;color:var(--muted)}
.pager .links{display:flex;gap:16px}
.pager a{font-weight:600;text-decoration:none}.pager a:hover{text-decoration:underline;text-underline-offset:3px}
.muted{color:var(--muted)}
.list a.user{color:var(--text);font-weight:600;text-decoration:none}.list a.user:hover{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin:-10px 0 18px;color:var(--muted);font-size:14px}
.meta a{font-weight:600;text-decoration:none}.meta a:hover{text-decoration:underline;text-underline-offset:3px}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:9px 24px;margin:0;font-size:14px}
.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
.card .list+.list{margin-top:12px}
.grid2 .list td.wrap{min-width:160px}

@media (max-width:720px){
  .top{padding:0 16px;column-gap:16px}
  .banner{padding:9px 16px}main{padding:22px 16px 4px}footer{padding:16px}
  .brand{padding:12px 0 2px}
  .top nav{margin:0 -16px;padding:0 6px}
  .overview{grid-template-columns:minmax(0,1fr)}
  .card{padding:16px 16px 12px}
  .chart{grid-template-rows:170px auto}
  .big{font-size:38px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stats dd{font-size:22px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
