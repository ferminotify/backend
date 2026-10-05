// Timetable + variations for one class or room, for a given week.
import { findEntity, getIndex, getTable, ENTITY_TYPES } from './school.js';
import { getVariations } from './variations.js';
import { buildWeek } from './merge.js';

export { ENTITY_TYPES, getIndex };

const TZ = 'Europe/Rome';
// The Apps Script publishes events from yesterday to today + 3 days (see calendar-to-sheet.gs).
const VARIATIONS_PAST_DAYS = 1;
const VARIATIONS_AHEAD_DAYS = 3;

/** Today's date at the school, "YYYY-MM-DD". */
export function schoolToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

// Date-only arithmetic in UTC so DST never shifts a day.
const parseDate = (s) => new Date(`${s}T00:00:00Z`);
const fmtDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
};
const isoWeekday = (s) => parseDate(s).getUTCDay() || 7;

/** Monday of the week containing `date`. On weekends, the upcoming week. */
export function weekStart(date) {
  const wd = isoWeekday(date);
  return wd >= 6 ? addDays(date, 8 - wd) : addDays(date, 1 - wd);
}

export function variationsWindow(today) {
  return { from: addDays(today, -VARIATIONS_PAST_DAYS), to: addDays(today, VARIATIONS_AHEAD_DAYS) };
}

/**
 * @returns {Promise<null | object>} null when the class/room does not exist.
 */
export async function getWeek(type, ref, { date } = {}) {
  const entity = await findEntity(type, ref);
  if (!entity) return null;

  const today = schoolToday();
  const monday = weekStart(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today);
  const window = variationsWindow(today);

  const [{ table, stale: tableStale }, { variations, stale: variationsStale }] = await Promise.all([
    getTable(type, entity.id),
    getVariations(),
  ]);

  const lastWeekday = Math.max(5, ...table.weekdays);
  const days = Array.from({ length: lastWeekday }, (_, i) => {
    const d = addDays(monday, i);
    return { date: d, weekday: i + 1, published: d >= window.from && d <= window.to };
  });

  const week = buildWeek({ entity: { ...entity, type }, table, variations, days });

  return {
    entity: { type, id: entity.id, key: entity.key, name: entity.name },
    today,
    weekStart: monday,
    prevWeek: addDays(monday, -7),
    nextWeek: addDays(monday, 7),
    variationsWindow: window,
    times: week.times,
    days: week.days,
    stale: tableStale || variationsStale,
    updatedAt: new Date().toISOString(),
  };
}
