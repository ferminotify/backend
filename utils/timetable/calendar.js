// Fetches timetable variations: the Calendar API when GOOGLE_CALENDAR_API_KEY is set,
// else Google Sheet in CSV 
//
// A full read of the window (~3000 events) runs hourly; in between, every
// EVENTS_TTL_MS only the events changed since the last read are fetched
// (updatedMin + showDeleted), usually none.
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
export function parseCsv(text) {
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

/** CSV text → events: { uid, summary, date, start, end, allDay } with local "HH:MM" times. */
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
      // dateTime strings carry the school's local offset ("2026-10-05T10:00:00+02:00"),
      // so date and wall-clock time are read straight from the string.
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
// Window: from Monday of last week, so the current and previous weeks are complete.
export const CALENDAR_PAST_DAYS = 13;
export const CALENDAR_AHEAD_DAYS = Number(process.env.CALENDAR_AHEAD_DAYS) || 42;

export const calendarEnabled = () => Boolean(process.env.GOOGLE_CALENDAR_API_KEY && process.env.GOOGLE_CALENDAR_ID);

export const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * One API event → events in our shape: { uid, summary, date, start, end, allDay }.
 * An all-day event over several days (a trip) becomes one event per day; its end date is
 * exclusive. Timed events carry the calendar's local offset, read straight from the string.
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
  for (let page = 0; page < 20; page++) {
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
  return items;
}

/** Every event between two days (YYYY-MM-DD, included), read in full: for occasional reads. */
export async function calendarEventsBetween(from, to) {
  const items = await listEvents({ timeMin: `${from}T00:00:00Z`, timeMax: `${addDays(to, 1)}T00:00:00Z` });
  return items.flatMap(toEvents);
}

// API items of the current window, by id.
let state = { from: null, to: null, items: new Map(), fullAt: 0, syncedAt: 0 };

/**
 * Events of the window around `today`, kept up to date incrementally.
 * @returns {Promise<{ events: object[], from: string, to: string }>}
 */
export async function getCalendarEvents(today) {
  const from = addDays(today, -CALENDAR_PAST_DAYS);
  const to = addDays(today, CALENDAR_AHEAD_DAYS);
  const window = { timeMin: `${from}T00:00:00Z`, timeMax: `${addDays(to, 1)}T00:00:00Z` };
  const now = Date.now();

  if (state.from !== from || now - state.fullAt > FULL_EVERY_MS) {
    const items = await listEvents(window);
    state = { from, to, items: new Map(items.map((i) => [i.id, i])), fullAt: now, syncedAt: now };
    log.debug('Calendar read', { from, to, events: items.length });
  } else {
    // A minute of overlap: an edit saved while the previous read ran is not missed.
    const updatedMin = new Date(state.syncedAt - 60 * 1000).toISOString();
    const changed = await listEvents({ ...window, updatedMin, showDeleted: 'true' });
    for (const i of changed) {
      if (i.status === 'cancelled') state.items.delete(i.id);
      else state.items.set(i.id, i);
    }
    state.syncedAt = now;
    if (changed.length) log.debug('Calendar changes', { events: changed.length });
  }

  const events = [...state.items.values()].flatMap(toEvents).filter((e) => e.date >= from && e.date <= to);
  return { events, from, to };
}

/** Today's date at the school, "YYYY-MM-DD". */
export function schoolToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

async function loadCsv() {
  const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Events CSV ${res.status}`);
  return { events: parseEventsCsv(await res.text()), window: null, source: 'csv' };
}

/**
 * All variations currently published, cached briefly. Each event gets its parsed fields merged in.
 * Source: the Calendar API when configured (below), else the Sheet CSV; the CSV is
 * also the fallback when the API fails. `window` is the date range the source covers
 * ({from, to}), or null for the CSV (its range is set by the Apps Script).
 */
export async function getVariations() {
  const { value, stale } = await eventsCache.get('events', async () => {
    let loaded;
    if (calendarEnabled()) {
      try {
        const { events, from, to } = await getCalendarEvents(schoolToday());
        loaded = { events, window: { from, to }, source: 'calendar' };
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
