// Timetable variations straight from the school's public Google Calendar (Calendar API v3,
// API key only). Replaces the Sheet CSV when GOOGLE_CALENDAR_API_KEY is set: the Sheet only
// holds yesterday → today + 3 days, the API gives any window.
//
// The calendar holds ~140k events since 2023, so it is never read whole: only the window
// below. A full read of the window (~3000 events) runs hourly; in between, every
// EVENTS_TTL_MS only the events changed since the last read are fetched
// (updatedMin + showDeleted), usually none.
import logger from '../logger.js';

const log = logger.child('timetable:calendar');

const API = 'https://www.googleapis.com/calendar/v3/calendars';
const TZ = 'Europe/Rome';
const FIELDS = 'nextPageToken,items(id,status,summary,start,end,updated)';
const FULL_EVERY_MS = 60 * 60 * 1000;
// Window: from Monday of last week, so the current and previous weeks are complete.
export const CALENDAR_PAST_DAYS = 13;
export const CALENDAR_AHEAD_DAYS = Number(process.env.CALENDAR_AHEAD_DAYS) || 42;

export const calendarEnabled = () => Boolean(process.env.GOOGLE_CALENDAR_API_KEY && process.env.GOOGLE_CALENDAR_ID);

const addDays = (s, n) => {
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
