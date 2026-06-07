import pool from '../db.js';
import dotenv from 'dotenv';
import logger from './logger.js';
dotenv.config();

const log = logger.child('events');

// School calendar (public). Source is swappable:
// - if GOOGLE_CALENDAR_API_KEY is set → read directly from Google Calendar API
//   (only the needed window), bypassing the spreadsheet.
// - else → fall back to the public Google Sheets CSV populated by the Apps Script.
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'isfermimantova@gmail.com';
const CALENDAR_API_KEY = process.env.GOOGLE_CALENDAR_API_KEY || '';
const SHEET_CSV_URL =
  process.env.EVENTS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1ADaUVRQeYU078-suUxGk0u1aMj_GbcjsAzG11YlMp5g/export?format=csv&gid=0';

// In-memory cache (per process). Calendar changes slowly; avoid hammering the source.
const CACHE_TTL_MS = 2 * 60 * 1000;
let cache = { at: 0, events: null };

/** Window: from start of yesterday to end of (today + days). */
function windowRange(days = 7) {
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 0);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

/** Normalized event shape: { uid, summary, description, start:{date,dateTime,timeZone}, end:{...} }. */
function fromApiItem(item) {
  return {
    uid: item.id,
    summary: item.summary || '',
    description: item.description || '',
    start: {
      date: item.start?.date || '',
      dateTime: item.start?.dateTime || '',
      timeZone: item.start?.timeZone || '',
    },
    end: {
      date: item.end?.date || '',
      dateTime: item.end?.dateTime || '',
      timeZone: item.end?.timeZone || '',
    },
  };
}

async function fetchFromApi({ timeMin, timeMax }) {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?key=${CALENDAR_API_KEY}` +
    `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&showDeleted=false&maxResults=2500`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendar API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.items || []).map(fromApiItem);
}

/** Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      // ignore; \n handles the row break
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchFromCsv() {
  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`CSV fetch ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  return rows.slice(1).map((r) => ({
    uid: r[idx('uid')] || r[0] || '',
    summary: r[idx('summary')] || '',
    description: r[idx('description')] || '',
    start: {
      date: r[idx('start.date')] || '',
      dateTime: r[idx('start.dateTime')] || '',
      timeZone: r[idx('start.timeZone')] || '',
    },
    end: {
      date: r[idx('end.date')] || '',
      dateTime: r[idx('end.dateTime')] || '',
      timeZone: r[idx('end.timeZone')] || '',
    },
  })).filter((e) => e.uid);
}

/** All events in the lookahead window, cached briefly. */
export async function fetchEvents() {
  if (cache.events && Date.now() - cache.at < CACHE_TTL_MS) return cache.events;
  let events;
  if (CALENDAR_API_KEY) {
    events = await fetchFromApi(windowRange());
  } else {
    events = await fetchFromCsv();
  }
  cache = { at: Date.now(), events };
  return events;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match events whose summary contains any keyword as a whole word.
 * Mirrors the notifier's filter_events_kw (normalize non-alphanumerics to spaces).
 */
export function filterByKeywords(events, keywords) {
  if (!keywords || keywords.length === 0) return [];
  const kws = keywords.filter(Boolean).map((k) => k.toLowerCase());
  return events.filter((evt) => {
    const title = (evt.summary || '')
      .replace(/[^a-zA-Z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return kws.some((kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`).test(title));
  });
}

/** Fuzzy class names similar to the user's tags (pg_trgm on the classes table). */
export async function getSimilarClasses(tags) {
  if (!tags || tags.length === 0) return [];
  const cleaned = tags.map((t) => String(t).replace(/\s+/g, ''));
  try {
    const res = await pool.query(
      `SELECT DISTINCT c.name AS best_match
         FROM UNNEST($1::text[]) AS kw(word)
         JOIN LATERAL (
           SELECT name FROM classes
           WHERE name % kw.word AND similarity(name, kw.word) > 0.3
           ORDER BY similarity(name, kw.word) DESC
           LIMIT 1
         ) c ON true`,
      [cleaned]
    );
    const set = new Set(tags);
    return res.rows.map((r) => r.best_match).filter((n) => !set.has(n));
  } catch (e) {
    log.error('getSimilarClasses failed', { error: e.stack || e });
    return [];
  }
}

/**
 * Events relevant to a user: exact keyword matches + (optionally) fuzzy "probabili".
 * Each event is tagged with `similar: true|false`. Deduplicated by uid.
 */
export async function getUserEvents(user) {
  const tags = Array.isArray(user?.tags) ? user.tags : [];
  const events = await fetchEvents();

  const matched = filterByKeywords(events, tags).map((e) => ({ ...e, similar: false }));

  let similar = [];
  if (user?.include_similar_tags) {
    const similarTags = await getSimilarClasses(tags);
    const matchedUids = new Set(matched.map((e) => e.uid));
    similar = filterByKeywords(events, similarTags)
      .filter((e) => !matchedUids.has(e.uid))
      .map((e) => ({ ...e, similar: true }));
  }

  return [...matched, ...similar];
}
