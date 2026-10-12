// Timetable + variations for one class or room, for a given week.
import { findEntity, getIndex, getTable, sessionSeesTeachers, ENTITY_TYPES, ALL_TYPES } from './school.js';
import { hasCredentials, SchoolSessionExpired } from './schoolSession.js';
import { getVariations, parseSummary } from './variations.js';
import { assessSummary, UNCERTAIN_BELOW } from './confidence.js';
import { buildWeek, concernsClass, concernsRoom, jointClasses, jointsOf, mentionsTeacher, teacherContext, variationSlots, SCHOOL_SLOTS } from './merge.js';

export { ENTITY_TYPES, ALL_TYPES, getIndex, sessionSeesTeachers, hasCredentials, SchoolSessionExpired };
export { loginWith, logoutSession, SchoolLoginError } from './schoolSession.js';

const TZ = 'Europe/Rome';
// The Sheet CSV (fallback source) holds events from yesterday to today + 3 days
// (see calendar-to-sheet.gs); the Calendar API source reports its own window.
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

/**
 * Monday of the week containing `date`. After the last school day (Saturday for timetables
 * with Saturday lessons, else Friday), the upcoming week.
 */
export function weekStart(date, lastWeekday = 5) {
  const wd = isoWeekday(date);
  return wd > lastWeekday ? addDays(date, 8 - wd) : addDays(date, 1 - wd);
}

export function variationsWindow(today) {
  return { from: addDays(today, -VARIATIONS_PAST_DAYS), to: addDays(today, VARIATIONS_AHEAD_DAYS) };
}

// --- reading confidence -----------------------------------------------------------------

let assessed = { index: null, bySummary: new Map() };

/**
 * Adds `reading` to each variation: { score, issues }, how sure the parser is (confidence.js).
 * Below UNCERTAIN_BELOW the timetable says the title was hard to read.
 */
async function withReadings(variations) {
  const pub = await getIndex().catch(() => null);
  const idx = pub ? { classes: pub.class || [], rooms: pub.room || [] } : { classes: [], rooms: [] };
  if (assessed.index !== pub) assessed = { index: pub, bySummary: new Map() };
  return variations.map((v) => {
    let base = assessed.bySummary.get(v.summary);
    if (!base) {
      base = assessSummary(v.summary, v, idx);
      assessed.bySummary.set(v.summary, base);
    }
    return { ...v, reading: { score: base.score, issues: base.issues } };
  });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.authed]  caller may see teachers: use the logged-in site
 *   (teachers in every cell, 'teacher' type). Falls back to the public page for
 *   classes/rooms when the school login fails.
 * @param {object} [opts.session]  the caller's own school session; default: service account.
 * @returns {Promise<null | object>} null when the class/room/teacher does not exist.
 */
export async function getWeek(type, ref, { date, authed = false, session } = {}) {
  const useAuthed = authed && Boolean(session || hasCredentials());
  if (type === 'teacher' && !useAuthed) return null;
  const entity = await findEntity(type, ref, { authed: useAuthed, session });
  if (!entity) return null;

  const today = schoolToday();
  const [{ table, stale: tableStale }, { variations: rawVariations, window: sourceWindow, stale: variationsStale }] = await Promise.all([
    getTable(type, entity.id, { authed: useAuthed, session }).catch((err) => {
      if (!useAuthed || type === 'teacher' || err instanceof SchoolSessionExpired) throw err;
      return getTable(type, entity.id); // school login down: public data, without teachers
    }),
    getVariations(),
  ]);

  const window = sourceWindow || variationsWindow(today);
  const variations = await withReadings(rawVariations);
  const lastWeekday = Math.max(5, ...table.weekdays);
  // The week shown when no date is asked for: this one, or the next after the last school day.
  const currentWeek = weekStart(today, lastWeekday);
  const monday = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? weekStart(date, lastWeekday) : currentWeek;
  const days = Array.from({ length: lastWeekday }, (_, i) => {
    const d = addDays(monday, i);
    return { date: d, weekday: i + 1, published: d >= window.from && d <= window.to };
  });

  const classIndex = (await getIndex().catch(() => null))?.class || [];
  const knownClasses = new Set(classIndex.map((c) => c.key));
  // A part of a joint class: its timetable lacks the hours taught together, added below.
  const joints = (type === 'class' ? jointsOf(entity.key, knownClasses) : [])
    .map((key) => classIndex.find((c) => c.key === key))
    .filter(Boolean);
  // Who teaches each lesson, to tell a substitution from a room change (see lessonRole): the
  // logged-in timetable when this one has no teachers. Only used to decide, never sent.
  const needTeachers = type !== 'teacher' && !table.lessons.some((l) => l.teachers?.length) && hasCredentials();
  const jointTable = (id, opts) => getTable('class', id, opts).then((r) => r.table, () => null);
  // Everything else at once: on a cold cache these are separate school-site pages.
  const [teacherIndex, ownWithTeachers, jointTables] = await Promise.all([
    // Teachers' names, to tell homonyms and typos ("BOTAZZI") apart: only on teacher pages.
    type === 'teacher' ? getIndex({ authed: true, session }).catch(() => null) : null,
    needTeachers ? getTable(type, entity.id, { authed: true }).then((r) => r.table, () => null) : null,
    Promise.all(
      joints.map(async (j) => {
        const [shownT, decideT] = await Promise.all([
          jointTable(j.id, { authed: useAuthed, session }),
          needTeachers ? jointTable(j.id, { authed: true }) : null,
        ]);
        return { joint: j, shown: shownT, decide: decideT };
      })
    ),
  ]);
  const teachers = teacherContext((teacherIndex?.teacher || []).map((t) => t.name));
  let shown = table;
  let decide = ownWithTeachers;
  for (const { joint, shown: jt, decide: jdt } of jointTables) {
    const others = (jointClasses(knownClasses).get(joint.key) || []).filter((k) => k !== entity.key);
    const otherNames = others.map((k) => classIndex.find((c) => c.key === k)?.name || k).join(', ');
    if (jt) shown = withJointLessons(shown, jt, otherNames);
    if (decide && jdt) decide = withJointLessons(decide, jdt, otherNames);
  }
  const week = buildWeek({ entity: { ...entity, type }, table: shown, variations, days, knownClasses, teachers, teacherTable: decide });

  return {
    entity: { type, id: entity.id, key: entity.key, name: entity.name },
    today,
    weekStart: monday,
    currentWeek,
    prevWeek: addDays(monday, -7),
    nextWeek: addDays(monday, 7),
    variationsWindow: window,
    times: week.times,
    extraTimes: week.extraTimes,
    days: week.days,
    stale: tableStale || variationsStale,
    withTeachers: table.lessons.some((l) => l.teachers?.length > 0),
    updatedAt: new Date().toISOString(),
  };
}

/** The part's timetable plus the joint class's lessons in the hours the part has none. */
function withJointLessons(table, jointTable, otherPart) {
  const busy = new Set(table.lessons.flatMap((l) => l.slots.map((s) => `${l.weekday}|${s}`)));
  const extra = jointTable.lessons
    .filter((l) => !l.slots.some((s) => busy.has(`${l.weekday}|${s}`)))
    .map((l) => ({ ...l, jointWith: otherPart }));
  return {
    ...table,
    times: [...new Set([...table.times, ...jointTable.times])].sort(),
    weekdays: [...new Set([...table.weekdays, ...jointTable.weekdays])].sort(),
    lessons: [...table.lessons, ...extra],
  };
}

const PREVIEW_MAX = 6;

/**
 * Test page (/orario/test): how an event title is read and what it does to the timetable.
 * Applies only this one (fake) event to the real timetables of the entities it concerns.
 * @param {{summary:string, date:string, start?:string, end?:string, allDay?:boolean}} ev
 * @param {{authed?:boolean, session?:object}} opts  teachers only for callers who may see them
 */
export async function testVariation(ev, { authed = false, session } = {}) {
  const useAuthed = authed && Boolean(session || hasCredentials());
  const raw = {
    uid: 'test',
    summary: ev.summary,
    date: ev.date,
    start: ev.allDay ? null : ev.start,
    end: ev.allDay ? null : ev.end || ev.start,
    allDay: Boolean(ev.allDay),
    ...parseSummary(ev.summary),
  };
  const [v] = await withReadings([raw]);
  const index = await getIndex(useAuthed ? { authed: true, session } : {});
  // With teachers known, also check the names (not done for the shared readings).
  if (index.teacher?.length) {
    const r = assessSummary(raw.summary, raw, { classes: index.class, rooms: index.room, teachers: index.teacher });
    v.reading = { ...v.reading, score: r.score, issues: r.issues };
  }
  const matches = [
    ...(index.class || []).filter((c) => concernsClass(v, c.key)).map((e) => ({ ...e, type: 'class' })),
    ...(index.room || []).filter((r) => concernsRoom(v, r)).map((e) => ({ ...e, type: 'room' })),
    ...(useAuthed ? index.teacher || [] : [])
      .filter((t) => mentionsTeacher(v.teachers, t.name) || mentionsTeacher(v.absent, t.name))
      .map((e) => ({ ...e, type: 'teacher' })),
  ];

  const weekday = new Date(`${ev.date}T00:00:00Z`).getUTCDay() || 7;
  const previews = await Promise.all(
    matches.slice(0, PREVIEW_MAX).map(async (entity) => {
      const { table } = await getTable(entity.type, entity.id, { authed: useAuthed, session });
      const week = buildWeek({ entity, table, variations: [v], days: [{ date: ev.date, weekday, published: true }] });
      const day = week.days[0];
      return {
        entity: { type: entity.type, key: entity.key, name: entity.name },
        times: week.times,
        cells: [...day.cells.filter((c) => c.variations.length), ...day.overlays], // overlays: real times over lessons
        notes: day.notes,
      };
    })
  );

  const { uid, summary, date, reading, ...parsed } = v;
  return {
    parsed,
    reading,
    uncertainBelow: UNCERTAIN_BELOW,
    slots: variationSlots(v, SCHOOL_SLOTS),
    matches: matches.map(({ type, key, name }) => ({ type, key, name })),
    previews,
    more: Math.max(0, matches.length - PREVIEW_MAX),
  };
}

/**
 * Test page examples: a few calendar events picked at random, with titles that differ in
 * shape (kind and wording, ignoring class codes, rooms and numbers) so each shows something new.
 */
export async function testExamples(count = 5) {
  const { variations } = await getVariations();
  const shape = (v) =>
    `${v.kind}|${v.summary
      .toUpperCase()
      .replace(/\b\d+[A-Z]*\b/g, '#')
      .replace(/[^A-Z#]+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 3)
      .join(' ')}`;
  const pool = [...variations].filter((v) => v.summary?.trim() && v.summary.length <= 200);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // One per shape, alternating kinds: changes are most events, the others would rarely show.
  const byKind = new Map();
  const seen = new Set();
  for (const v of pool) {
    const k = shape(v);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(v);
  }
  const out = [];
  const lists = [...byKind.values()];
  for (let i = 0; out.length < count && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < count) out.push(l[i]);
  }
  return out.map((v) => ({ summary: v.summary.trim(), date: v.date, start: v.start || null, end: v.end || null, allDay: Boolean(v.allDay) }));
}
