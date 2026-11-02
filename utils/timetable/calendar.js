// Fetches timetable variations: the Calendar API when GOOGLE_CALENDAR_API_KEY is set,
// else Google Sheet in CSV 
//
// Window: from 13 days ago, every future event (the past, ~140k events since 2023, is not read).
// A full read of the window runs hourly; in between, every
// EVENTS_TTL_MS only the events changed since the last read are fetched
// (updatedMin + showDeleted), usually none.
// Risk: with no end date, a recurring event without an end (singleEvents) expands into every
// occurrence; reads stop at MAX_PAGES × 2500 events, logged as "Calendar read cut".
import logger from '../logger.js';
import { createCache } from './cache.js';
import { parseSummary } from './parse.js';

const log = logger.child('timetable:variations');

const CSV_URL =
  process.env.EVENTS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1ADaUVRQeYU078-suUxGk0u1aMj_GbcjsAzG11YlMp5g/export?format=csv&gid=0';
const TTL_MS = Number(process.env.EVENTS_TTL_MS) || 2 * 60 * 1000;

const eventsCache = createCache({ ttlMs: TTL_MS, maxEntries: 1 });

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text → events: { uid, summary, date, start, end, allDay } */
export function parseEventsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (r, name) => r[header.indexOf(name)] || '';
  return rows
    .slice(1)
    .map((r) => {
      const startDT = col(r, 'start.dateTime');
      const endDT = col(r, 'end.dateTime');
      // dateTime strings carry local offset ("2026-10-05T10:00:00+02:00"),
      const allDay = !startDT;
      return {
        uid: col(r, 'uid'),
        summary: col(r, 'summary').trim(),
        date: allDay ? col(r, 'start.date') : startDT.slice(0, 10),
        start: allDay ? null : startDT.slice(11, 16),
        end: allDay ? null : endDT.slice(11, 16) || startDT.slice(11, 16),
        allDay,
      };
    })
    .filter((e) => e.uid && e.summary && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
}

// --- Calendar API ---------------------------------------------------------------------------

const API = 'https://www.googleapis.com/calendar/v3/calendars';
const TZ = 'Europe/Rome';
const FIELDS = 'nextPageToken,items(id,status,summary,start,end,updated)';
const FULL_EVERY_MS = 60 * 60 * 1000;
const MAX_PAGES = 20;
// Window: from Monday of last week, so the current and previous weeks are complete.
const CALENDAR_PAST_DAYS = 13;

export const calendarEnabled = () => Boolean(process.env.GOOGLE_CALENDAR_API_KEY && process.env.GOOGLE_CALENDAR_ID);

export const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * One API event { uid, summary, date, start, end, allDay }.
 * All-day event over several days = one event per day
 */
export function toEvents(item) {
  const summary = String(item.summary || '').trim();
  if (!summary || item.status === 'cancelled') return [];
  if (item.start?.date) {
    const out = [];
    const last = item.end?.date ? addDays(item.end.date, -1) : item.start.date;
    for (let d = item.start.date, i = 0; d <= last && i < 31; d = addDays(d, 1), i++) {
      out.push({ uid: i ? `${item.id}@${d}` : item.id, summary, date: d, start: null, end: null, allDay: true });
    }
    return out;
  }
  const s = item.start?.dateTime;
  if (!s) return [];
  const e = item.end?.dateTime || s;
  // Ending on another day (rare): keep the first day, up to the end of the school day.
  const end = e.slice(0, 10) === s.slice(0, 10) ? e.slice(11, 16) : '23:59';
  return [{ uid: item.id, summary, date: s.slice(0, 10), start: s.slice(11, 16), end, allDay: false }];
}

async function listEvents(params) {
  const id = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const items = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      key: process.env.GOOGLE_CALENDAR_API_KEY,
      singleEvents: 'true',
      maxResults: '2500',
      timeZone: TZ,
      fields: FIELDS,
      ...params,
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${API}/${id}/events?${q}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const why = (await res.json().catch(() => ({})))?.error?.message || '';
      throw new Error(`Calendar API ${res.status}: ${why.slice(0, 160)}`);
    }
    const data = await res.json();
    items.push(...(data.items || []));
    if (!data.nextPageToken) return items;
    pageToken = data.nextPageToken;
  }
  log.warn('Calendar read cut at the page limit', { events: items.length });
  return items;
}

// From `from` (YYYY-MM-DD) on, with no end.
const since = (from) => ({ timeMin: `${from}T00:00:00Z` });

/** Every event from `from` on, read in full: for occasional reads. */
export async function calendarEventsSince(from) {
  const items = await listEvents(since(from));
  return items.flatMap(toEvents);
}

// API items of the current window, by id.
let state = { from: null, items: new Map(), fullAt: 0, syncedAt: 0 };

/**
 * Events from CALENDAR_PAST_DAYS before `today` on (no end), kept up to date incrementally.
 * @returns {Promise<{ events: object[], from: string }>}
 */
async function getCalendarEvents(today) {
  const from = addDays(today, -CALENDAR_PAST_DAYS);
  const window = since(from);
  const now = Date.now();

  if (state.from !== from || now - state.fullAt > FULL_EVERY_MS) { // read all events
    const items = await listEvents(window);
    state = { from, items: new Map(items.map((i) => [i.id, i])), fullAt: now, syncedAt: now };
    log.debug('Calendar read', { from, events: items.length });
  } else { // read only the changes since the last read
    const updatedMin = new Date(state.syncedAt - 60 * 1000).toISOString();
    const changed = await listEvents({ ...window, updatedMin, showDeleted: 'true' });
    for (const i of changed) {
      if (i.status === 'cancelled') state.items.delete(i.id);
      else state.items.set(i.id, i);
    }
    state.syncedAt = now;
    if (changed.length) log.debug('Calendar changes', { events: changed.length });
  }

  const events = [...state.items.values()].flatMap(toEvents).filter((e) => e.date >= from);
  return { events, from };
}

export function schoolToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

async function loadCsv() {
  const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Events CSV ${res.status}`);
  return { events: parseEventsCsv(await res.text()), window: null, source: 'csv' };
}

/**
 * All variations cached briefly.
 * `window` is the date range the source covers
 * ({from, to}, to null = no end), or null for the CSV
 */
export async function getVariations() {
  const { value, stale } = await eventsCache.get('events', async () => {
    let loaded;
    if (calendarEnabled()) {
      try {
        const { events, from } = await getCalendarEvents(schoolToday());
        loaded = { events, window: { from, to: null }, source: 'calendar' };
      } catch (err) {
        log.warn('Calendar API failed, using the CSV', { error: err.message });
      }
    }
    loaded ||= await loadCsv();
    log.debug('Fetched variations', { count: loaded.events.length, source: loaded.source });
    const variations = loaded.events.map((e) => ({ ...e, ...parseSummary(e.summary) }));
    return { variations, window: loaded.window, source: loaded.source };
  });
  if (stale) log.warn('Serving stale variations');
  return { ...value, stale };
}
