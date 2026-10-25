// Teachers' surnames as the public calendar prints them ("PROF. ROSSI", "(PROF.ssa DEL
// MODELLO: ASSENTE)"), for keyword suggestions to everyone: the school's own teacher list
// (reserved area) stays for school accounts and Moodle sessions (routes/timetable.js).
//
// Only names after a teacher's title: titles also name students ("TUTOR MARCHESINI (3A)")
// and guests ("ING. VERDI"), never listed. A name seen once is likely a typo, left out.
// Read from the start of the school year, once a day, in the background.
import logger from '../logger.js';
import { calendarEnabled, calendarEventsBetween, CALENDAR_AHEAD_DAYS } from './calendar.js';
import { getVariations, parseSummary } from './variations.js';
import { schoolToday } from './index.js';

const log = logger.child('timetable:calendar-names');

const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MIN_SEEN = 2;

let names = []; // last good list
let loadedAt = 0;
let failedAt = 0;
let loading = null;

const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 1 September of the school year `today` falls in. */
export function schoolYearStart(today) {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 9 ? y : y - 1}-09-01`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Surnames printed after a teacher's title in these titles, seen at least MIN_SEEN times.
 * "FERRARI F." counts as FERRARI: the keyword is the surname.
 * @param {string[]} summaries event titles
 * @returns {string[]} upper-case surnames, sorted
 */
export function surnamesFromTitles(summaries) {
  const seen = new Map();
  for (const summary of summaries) {
    const upper = String(summary || '').toUpperCase();
    const p = parseSummary(summary);
    const inTitle = new Set();
    for (const n of [...(p.teachers || []), ...(p.absent || [])]) {
      const name = n.toUpperCase().replace(/\s+[A-Z]\.?$/, '').replace(/\s+/g, ' ').trim();
      if (name.length < 3 || /\d/.test(name)) continue;
      // The name sits in the same segment as a teacher's title: "PROF.", "PROFF.", "PROF.SSA".
      const first = escapeRe(name.split(' ')[0]);
      if (!new RegExp(`\\bPROF[A-Z]*\\.?\\s*[^\\-()]*\\b${first}\\b`).test(upper)) continue;
      inTitle.add(name);
    }
    for (const name of inTitle) seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n >= MIN_SEEN).map(([name]) => name).sort();
}

async function load() {
  const today = schoolToday();
  const events = calendarEnabled()
    ? await calendarEventsBetween(schoolYearStart(today), addDays(today, CALENDAR_AHEAD_DAYS))
    : (await getVariations()).variations; // the CSV: only a few days, better than nothing
  const list = surnamesFromTitles(events.map((e) => e.summary));
  if (list.length) {
    names = list;
    loadedAt = Date.now();
  }
  log.info('Calendar surnames', { events: events.length, names: list.length });
}

/**
 * The surnames, never waiting: the first call (and one a day) starts a read in the
 * background and gets the last good list meanwhile ([] right after a restart).
 * @returns {string[]}
 */
export function calendarSurnames() {
  const now = Date.now();
  const stale = now - loadedAt > REFRESH_MS && now - failedAt > RETRY_MS;
  if (stale && !loading) {
    loading = load()
      .catch((err) => {
        failedAt = Date.now();
        log.warn('Calendar surnames unavailable', { error: err.message });
      })
      .finally(() => (loading = null));
  }
  return names;
}
