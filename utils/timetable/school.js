// School timetable source: https://www.fermimn.edu.it/orario/
// The site renders one HTML table per class (?class=<id>) or room (?room=<id>);
// there is no API and no CORS, so the backend fetches and converts it to JSON.
import logger from '../logger.js';
import { createCache } from './cache.js';
import { entityKey } from './normalize.js';

const log = logger.child('timetable:school');

const BASE_URL = process.env.TIMETABLE_URL || 'https://www.fermimn.edu.it/orario/';
const TTL_MS = Number(process.env.TIMETABLE_TTL_MS) || 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Class/room/teacher lists change rarely: a month. A day while the teachers still include
// placeholders (start of the year), so the real names show up soon.
const INDEX_TTL_MS = Number(process.env.TIMETABLE_INDEX_TTL_MS) || 30 * DAY_MS;
const indexTtl = (index) => (index?.teacher?.some((t) => isPlaceholderTeacher(t.name)) ? DAY_MS : INDEX_TTL_MS);

/** A chair not assigned yet: "A40 CATT 1", "A40 COE 3D" (subject code first, never a name). */
export function isPlaceholderTeacher(name) {
  return /^[A-Z]{1,2}\d{2,3}\b/i.test(String(name).trim());
}

// Public types; 'teacher' exists only on the logged-in site.
export const ENTITY_TYPES = ['class', 'room'];
export const ALL_TYPES = [...ENTITY_TYPES, 'teacher'];

const WEEKDAYS = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const indexCache = createCache({ ttlMs: indexTtl, maxEntries: 2 });
const tableCache = createCache({ ttlMs: TTL_MS, maxEntries: 800 });

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

/**
 * Entries of a cell line, one per <br>. The site wraps long names with "<br> " (a space
 * after the break): "DEL PROPOSTO<br> LUIGINO GIOVANNI" is one teacher, while
 * "Aula 619 Disegno B<br>Lab 609 CAD" are two rooms.
 */
export function brEntries(html) {
  const out = [];
  for (const part of String(html).split(/<br\s*\/?>/i)) {
    const text = textOf(part);
    if (!text) continue;
    if (/^\s/.test(part) && out.length) out[out.length - 1] += ` ${text}`;
    else out.push(text);
  }
  return out;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'(.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

// `session`: a user's school session (see loginWith below), needed when `authed`.
async function fetchPage(query = '', { authed = false, session } = {}) {
  const url = BASE_URL + query;
  if (authed) return fetchAuthed(url, { session });
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
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
  for (const type of ALL_TYPES) {
    const select = html.match(new RegExp(`<select[^>]*name="${type}"[^>]*>([\\s\\S]*?)</select>`));
    const options = select ? [...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)] : [];
    index[type] = options
      .map(([, id, label]) => ({ id, name: textOf(label) }))
      .filter((o) => o.id && o.name)
      .map((o) => ({ ...o, name: type === 'teacher' ? titleCase(o.name) : o.name }))
      .map((o) => ({ ...o, key: entityKey(o.name) }));
  }
  return index;
}

/**
 * Converts the timetable <table> into explicit lessons, resolving rowspans.
 * Rows (times) and columns (weekdays) vary per entity, so both come from the headers.
 *
 * Cell lines: class view [subject, room], room view [subject, class],
 * teacher view [subject, room, class]; logged in, a last line lists the teachers.
 *
 * @param {object} [opts]
 * @param {'class'|'room'|'teacher'} [opts.type]
 * @param {boolean} [opts.withTeachers]  page fetched logged in
 * @returns {{ times: string[], weekdays: number[], lessons: Array<{
 *   weekday: number, start: string, span: number, subject: string, detail: string,
 *   room: string|null, className: string|null, teachers: string[], color: string|null
 * }> }}
 *   weekday is ISO (1 = Monday). `detail` is what the cell shows under the subject: the room
 *   (class view), the class (room view), "class · room" (teacher view).
 */
export function parseTable(html, { type = 'class', withTeachers = false } = {}) {
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

      const raw = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(([, p]) => p);
      if (!raw.some((p) => textOf(p))) continue; // free hour
      const baseCount = type === 'teacher' ? 3 : 2;
      // Teachers: last line, one per <br>. Only when the cell has more lines than the public one.
      const teachers =
        withTeachers && raw.length > baseCount
          ? brEntries(raw.pop()).map(titleCase)
          : [];
      // Several rooms/classes in one line: "Aula 619 Disegno B, Lab 609 CAD".
      const lines = raw.map((p) => brEntries(p).join(', '));
      const [subject, second = '', third = ''] = lines;
      const room = type === 'room' ? null : second || null;
      const className = type === 'class' ? null : (type === 'teacher' ? third : second) || null;
      lessons.push({
        weekday: weekdays[col],
        start: times[times.length - 1],
        span,
        subject,
        detail: type === 'teacher' ? [className, room].filter(Boolean).join(' · ') : lines.slice(1).filter(Boolean).join(' · '),
        room,
        className,
        teachers,
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

/**
 * Classes and rooms (public page), plus teachers when `authed` (logged-in page).
 * @returns {{ class, room, teacher? }}
 */
// Logged-in pages are the same for every account that can see them, so the cache is
// shared: whichever session misses first fetches for everybody. Without a session, only
// what is cached (Cerca eventi, notifier); throws if nothing is.
export async function getIndex({ authed = false, session } = {}) {
  if (authed && !session) return cachedOnly(indexCache, 'authed');
  const { value, stale } = await indexCache.get(authed ? 'authed' : 'public', async () => {
    log.info('Fetching timetable index', { authed });
    return parseIndex(await fetchPage('', { authed, session }));
  });
  if (stale) log.warn('Serving stale timetable index', { authed });
  return value;
}

function cachedOnly(cache, key) {
  const value = cache.peek(key);
  if (!value) throw new Error('Logged-in page not cached and no school session');
  return value;
}

/** Whether this school session sees the teachers' timetable (fresh fetch, no cache). */
export async function sessionSeesTeachers(session) {
  return parseIndex(await fetchPage('', { authed: true, session })).teacher.length > 0;
}

/** Finds a class/room/teacher by key ("3AIIN"), id or exact name. Teachers need `authed`. */
export async function findEntity(type, ref, { authed = false, session } = {}) {
  if (!(authed ? ALL_TYPES : ENTITY_TYPES).includes(type)) return null;
  const index = await getIndex({ authed: authed || type === 'teacher', session });
  const key = entityKey(ref);
  return index[type]?.find((e) => e.key === key || e.id === String(ref)) || null;
}

/** Timetable of one entity. `authed`: the logged-in page, which adds teachers (as getIndex). */
export async function getTable(type, id, { authed = false, session } = {}) {
  if (authed && !session) return { table: cachedOnly(tableCache, `a:${type}:${id}`), stale: true };
  const { value, stale } = await tableCache.get(`${authed ? 'a' : 'p'}:${type}:${id}`, async () => {
    log.info('Fetching timetable', { type, id, authed });
    return parseTable(await fetchPage(`?${type}=${encodeURIComponent(id)}`, { authed, session }), { type, withTeachers: authed });
  });
  return { table: value, stale };
}

// --- Logged-in access ----------------------------------------------------------------------
// Logged-in access to https://www.fermimn.edu.it (Django site). The reserved area adds
// teachers to the timetable, for the accounts the school allows. Only users' own sessions,
// from loginWith() with their school (Moodle) credentials: the password is only forwarded
// to the school site, never stored or logged.
//
// Login flow: GET /_util/login/ (csrftoken cookie + hidden csrfmiddlewaretoken),
// POST the form with Referer (Django checks it on HTTPS) → 302 + sessionid cookie.
const ORIGIN = new URL(process.env.TIMETABLE_URL || 'https://www.fermimn.edu.it/orario/').origin;
const LOGIN_URL = `${ORIGIN}/_util/login/`;
// Sent with every request to the school site.
export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  'sec-ch-ua': '"Brave";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
};

/** Wrong username/password (the school re-renders the form). */
export class SchoolLoginError extends Error {}
/** A user's session was rejected by the school (expired, logged out, password changed). */
export class SchoolSessionExpired extends Error {}

function storeCookies(res, jar) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Logs in with the given credentials. Returns the session cookies ({ sessionid, csrftoken }).
 * Throws SchoolLoginError on wrong credentials.
 */
export async function loginWith(username, password) {
  const jar = new Map();
  const page = await fetch(LOGIN_URL, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) });
  storeCookies(page, jar);
  const html = await page.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!token || !jar.has('csrftoken')) throw new Error('School login page: CSRF token not found');

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(jar),
      Referer: LOGIN_URL,
      Origin: ORIGIN,
    },
    body: new URLSearchParams({ csrfmiddlewaretoken: token, username, password, next: '' }),
    signal: AbortSignal.timeout(15000),
  });
  storeCookies(res, jar);
  // Django answers 302 on success and re-renders the form (200) on bad credentials.
  if (res.status === 200) throw new SchoolLoginError('Wrong school credentials');
  if (res.status !== 302 || !jar.has('sessionid')) throw new Error(`School login failed (status ${res.status})`);
  return { sessionid: jar.get('sessionid'), csrftoken: jar.get('csrftoken') };
}

const isLoginRedirect = (res) =>
  res.status >= 300 && res.status < 400 && (res.headers.get('location') || '').includes('/_util/login');

// An expired session does not always redirect: /orario/ just renders the public page.
// Logged-in pages carry the logout form.
const LOGOUT_PATH = '/auth/logout/';
const isLoggedInPage = (html) => html.includes(`action="${LOGOUT_PATH}"`);

/**
 * GET a page of the school site with a user's session (their cookies).
 * A rejected session throws SchoolSessionExpired.
 */
export async function fetchAuthed(url, { session }) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { ...BROWSER_HEADERS, Cookie: cookieHeader(new Map(Object.entries(session))) },
    signal: AbortSignal.timeout(15000),
  });
  if (!isLoginRedirect(res) && !res.ok) throw new Error(`School page ${res.status} for ${url}`);
  const html = isLoginRedirect(res) ? '' : await res.text();
  if (!isLoggedInPage(html)) {
    // Tagged: with the shared cache, another request may be waiting on this fetch.
    throw Object.assign(new SchoolSessionExpired('School session expired'), { session });
  }
  return html;
}

/** Ends a user's session on the school site (best effort). */
export async function logoutSession(session) {
  try {
    await fetch(`${ORIGIN}${LOGOUT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(new Map(Object.entries(session))),
        Referer: `${ORIGIN}/orario/`,
        Origin: ORIGIN,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: session.csrftoken || '' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // the session expires on its own anyway
  }
}
