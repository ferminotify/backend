// School timetable source: https://www.fermimn.edu.it/orario/
// The site renders one HTML table per class (?class=<id>) or room (?room=<id>);
// there is no API and no CORS, so the backend fetches and converts it to JSON.
import logger from '../logger.js';
import { createCache } from './cache.js';
import { entityKey } from './normalize.js';

const log = logger.child('timetable:school');

const BASE_URL = process.env.TIMETABLE_URL || 'https://www.fermimn.edu.it/orario/';
const TTL_MS = Number(process.env.TIMETABLE_TTL_MS) || 6 * 60 * 60 * 1000;
const USER_AGENT = 'FermiNotify/1.0 (+https://fn.lkev.in)';

export const ENTITY_TYPES = ['class', 'room'];

const WEEKDAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const indexCache = createCache({ ttlMs: TTL_MS, maxEntries: 1 });
const tableCache = createCache({ ttlMs: TTL_MS, maxEntries: 300 });

const decodeEntities = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const textOf = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function fetchPage(query = '') {
  const url = BASE_URL + query;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`School timetable ${res.status} for ${url}`);
  return res.text();
}

/**
 * Lists of classes and rooms from the two <select>s on the page.
 * @returns {{ class: Array<{id,name,key}>, room: Array<{id,name,key}> }}
 */
export function parseIndex(html) {
  const index = {};
  for (const type of ENTITY_TYPES) {
    const select = html.match(new RegExp(`<select[^>]*name="${type}"[^>]*>([\\s\\S]*?)</select>`));
    const options = select ? [...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)] : [];
    index[type] = options
      .map(([, id, label]) => ({ id, name: textOf(label) }))
      .filter((o) => o.id && o.name)
      .map((o) => ({ ...o, key: entityKey(o.name) }));
  }
  return index;
}

/**
 * Converts the timetable <table> into explicit lessons, resolving rowspans.
 * Rows (times) and columns (weekdays) vary per entity, so both come from the headers.
 *
 * @returns {{ times: string[], weekdays: number[], lessons: Array<{
 *   weekday: number, start: string, span: number, subject: string, detail: string, color: string|null
 * }> }}
 *   weekday is ISO (1 = Monday). `detail` is the second line of the cell: the room in a
 *   class timetable, the class in a room timetable.
 */
export function parseTable(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/);
  if (!tableMatch) return { times: [], weekdays: [], lessons: [] };
  const table = tableMatch[0];

  const head = table.match(/<thead[\s\S]*?<\/thead>/)?.[0] || '';
  const weekdays = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(([, inner]) => WEEKDAYS.indexOf(textOf(inner).toLowerCase()) + 1)
    .filter((d) => d > 0);

  const body = table.match(/<tbody[\s\S]*?<\/tbody>/)?.[0] || '';
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, inner]) => inner);

  const times = [];
  const lessons = [];
  // Rows still covered by a rowspan from above, per column.
  const covered = new Array(weekdays.length).fill(0);

  rows.forEach((row) => {
    const time = textOf(row.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] || '');
    if (!/^\d{1,2}:\d{2}$/.test(time)) return;
    times.push(time.padStart(5, '0'));

    const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    let cellIdx = 0;
    for (let col = 0; col < weekdays.length; col++) {
      if (covered[col] > 0) {
        covered[col]--;
        continue;
      }
      const cell = cells[cellIdx++];
      if (!cell) break;
      const [, attrs, inner] = cell;
      const span = Number(attrs.match(/rowspan="(\d+)"/)?.[1] || 1);
      covered[col] = span - 1;

      const lines = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(([, p]) => textOf(p)).filter(Boolean);
      if (!lines.length) continue; // free hour
      lessons.push({
        weekday: weekdays[col],
        start: times[times.length - 1],
        span,
        subject: lines[0],
        detail: lines.slice(1).join(' · '),
        color: attrs.match(/background-color:\s*(#[0-9a-f]{3,8})/i)?.[1] || null,
      });
    }
  });

  // Turn row spans into explicit slot lists (rows may skip times, e.g. only 13:00 + 14:15).
  for (const lesson of lessons) {
    const from = times.indexOf(lesson.start);
    lesson.slots = times.slice(from, from + lesson.span);
  }

  return { times, weekdays, lessons };
}

export async function getIndex() {
  const { value, stale } = await indexCache.get('index', async () => {
    log.info('Fetching timetable index');
    return parseIndex(await fetchPage());
  });
  if (stale) log.warn('Serving stale timetable index');
  return value;
}

/** Finds a class/room by key ("3AIIN"), id or exact name. */
export async function findEntity(type, ref) {
  if (!ENTITY_TYPES.includes(type)) return null;
  const index = await getIndex();
  const key = entityKey(ref);
  return index[type].find((e) => e.key === key || e.id === String(ref)) || null;
}

export async function getTable(type, id) {
  const { value, stale } = await tableCache.get(`${type}:${id}`, async () => {
    log.info('Fetching timetable', { type, id });
    return parseTable(await fetchPage(`?${type}=${encodeURIComponent(id)}`));
  });
  return { table: value, stale };
}
