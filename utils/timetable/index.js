// Timetable + variations for one class or room, for a given week.
import { findEntity, getIndex, getTable, sessionSeesTeachers, ENTITY_TYPES, ALL_TYPES } from './school.js';
import { hasCredentials, SchoolSessionExpired } from './schoolSession.js';
import { getVariations, parseSummary } from './variations.js';
import { assessSummary, AI_THRESHOLD } from './confidence.js';
import { aiBudget, aiCached, aiEnabled, aiInterpret, aiMarkSeen, aiQueue, aiState } from './ai.js';
import { entityKey, sameClassKey, sameRoom } from './normalize.js';
import { buildWeek, concernsClass, concernsRoom, mentionsTeacher, variationSlots, SCHOOL_SLOTS } from './merge.js';

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

/** Monday of the week containing `date`. On weekends, the upcoming week. */
export function weekStart(date) {
  const wd = isoWeekday(date);
  return wd >= 6 ? addDays(date, 8 - wd) : addDays(date, 1 - wd);
}

export function variationsWindow(today) {
  return { from: addDays(today, -VARIATIONS_PAST_DAYS), to: addDays(today, VARIATIONS_AHEAD_DAYS) };
}

// --- reading confidence + AI fallback --------------------------------------------------

// The AI's answer replaces the parser's only when the AI itself is reasonably sure.
const AI_MIN_CONFIDENCE = 50;
const AI_FIELDS = ['classes', 'group', 'kind', 'label', 'room', 'roomNumber', 'teachers', 'absent'];
let assessed = { index: null, bySummary: new Map() };

/**
 * Adds `reading` to each variation: { score, issues, ai? }. Titles read with low confidence
 * are re-read by the AI (when configured): its fields replace the parser's. The AI answer
 * is fetched in the background and used from the next request, unless `waitAi`.
 */
/** Differences between the parser's and the AI's reading, in words; [] = they agree. */
export function readingDiffs(parsed, ai, idx = { classes: [] }) {
  const diffs = [];
  // Classes as the timetable entity they resolve to: "5EELEET" and "5EELEEET" agree.
  const resolve = (c) => idx.classes.find((k) => sameClassKey(entityKey(c), k.key))?.key || entityKey(c);
  const set = (a) => [...new Set((a || []).map(resolve))].sort().join(',');
  if (set(parsed.classes) !== set(ai.classes)) diffs.push(`classi: ${parsed.classes.join(', ') || '—'} → ${ai.classes.join(', ') || '—'}`);
  if (parsed.kind !== ai.kind) diffs.push(`tipo: ${parsed.label || 'variazione'} → ${ai.label || 'variazione'}`);
  const roomSame = !parsed.room && !ai.room ? true : parsed.room && ai.room ? sameRoom(parsed.room, ai.room) || sameRoom(ai.room, parsed.room) : false;
  if (!roomSame) diffs.push(`aula: ${parsed.room || '—'} → ${ai.room || '—'}`);
  // Names: "Vighi Giulia" ≈ "Vighi", "Camurri M." ≈ "Camurri", "D'Amato" ≈ "Amato",
  // "Pasetti" ≈ "Passetti" (a word in common, one name inside the other, or one letter off).
  const words = (n) => n.split(/\s+/).map(entityKey).filter((w) => w.length > 1);
  const sameName = (a, b) => {
    const ka = entityKey(a);
    const kb = entityKey(b);
    return (
      ka.includes(kb) || kb.includes(ka) || words(a).some((w) => words(b).includes(w)) || (ka.length > 4 && editDistance1(ka, kb))
    );
  };
  const sameNames = (a = [], b = []) => a.length === b.length && a.every((x) => b.some((y) => sameName(x, y)));
  if (!sameNames(parsed.teachers, ai.teachers)) diffs.push(`docenti: ${parsed.teachers.join(', ') || '—'} → ${ai.teachers.join(', ') || '—'}`);
  if (!sameNames(parsed.absent, ai.absent)) diffs.push(`assenti: ${parsed.absent.join(', ') || '—'} → ${ai.absent.join(', ') || '—'}`);
  return diffs;
}

/** Strings at most one edit apart. */
function editDistance1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const concernsSomething = (v) => v.classes.length || v.room || v.teachers.length || v.absent.length;

/**
 * Adds `reading` to each variation:
 *   { score, issues,                  parser confidence (confidence.js)
 *     check: { state, confidence, reason, model, diffs },   AI double check
 *     ai, aiRejected }                 AI reading used instead of the parser's (or refused)
 * Every event that touches the timetable is double checked by the AI in the background,
 * within the AI budget (doubtful ones first); results show from the next request.
 * Below AI_THRESHOLD the AI's reading replaces the parser's, if the AI is sure enough.
 */
async function withReadings(variations, { waitAi = false, today = null } = {}) {
  const pub = await getIndex().catch(() => null);
  const idx = pub ? { classes: pub.class || [], rooms: pub.room || [] } : { classes: [], rooms: [] };
  if (assessed.index !== pub) assessed = { index: pub, bySummary: new Map() };
  aiMarkSeen(new Set(variations.map((v) => v.summary)));
  return Promise.all(
    variations.map(async (v) => {
      let base = assessed.bySummary.get(v.summary);
      if (!base) {
        base = assessSummary(v.summary, v, idx);
        assessed.bySummary.set(v.summary, base);
      }
      const reading = { score: base.score, issues: base.issues, check: { state: 'off' }, ai: null, aiRejected: null };
      if (!aiEnabled() || !idx.classes.length) return { ...v, reading };
      if (!concernsSomething(v) && base.score >= AI_THRESHOLD) return { ...v, reading: { ...reading, check: { state: 'skipped' } } };

      let ai = aiCached(v.summary);
      // Days already over are not worth the AI budget: only readings already made are used.
      if (!ai && today && v.date < today) return { ...v, reading: { ...reading, check: { state: 'skipped' } } };
      if (!ai && waitAi) ai = await aiInterpret(v.summary, idx);
      if (!ai) {
        aiQueue(v.summary, idx, { priority: base.score });
        return { ...v, reading: { ...reading, check: { state: aiState(v.summary) === 'failed' ? 'failed' : 'queued' } } };
      }

      const info = { confidence: ai.confidence, reason: ai.reason, model: ai.model };
      const diffs = readingDiffs(v, ai, idx);
      const check = { state: diffs.length ? 'disagree' : 'agree', ...info, diffs };
      if (base.score >= AI_THRESHOLD || !diffs.length) return { ...v, reading: { ...reading, check } };
      if (ai.confidence != null && ai.confidence < AI_MIN_CONFIDENCE) return { ...v, reading: { ...reading, check, aiRejected: info } };
      const fields = Object.fromEntries(AI_FIELDS.map((k) => [k, ai[k]]));
      return { ...v, ...fields, reading: { ...reading, check, ai: info } };
    })
  );
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
  const monday = weekStart(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today);
  const [{ table, stale: tableStale }, { variations: rawVariations, window: sourceWindow, stale: variationsStale }] = await Promise.all([
    getTable(type, entity.id, { authed: useAuthed, session }).catch((err) => {
      if (!useAuthed || type === 'teacher' || err instanceof SchoolSessionExpired) throw err;
      return getTable(type, entity.id); // school login down: public data, without teachers
    }),
    getVariations(),
  ]);

  const window = sourceWindow || variationsWindow(today);
  const variations = await withReadings(rawVariations, { today });
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
    withTeachers: table.lessons.some((l) => l.teachers?.length > 0),
    updatedAt: new Date().toISOString(),
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
  const [v] = await withReadings([raw], { waitAi: true });
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
        cells: day.cells.filter((c) => c.variations.length),
        notes: day.notes,
      };
    })
  );

  const { uid, summary, date, reading, ...parsed } = v;
  const { uid: _u, summary: _s, date: _d, ...parserOnly } = raw;
  return {
    parsed,
    parser: reading.ai ? parserOnly : null, // what the parser read, when the AI replaced it
    reading,
    aiEnabled: aiEnabled(),
    aiBudget: aiEnabled() ? aiBudget() : null,
    aiThreshold: AI_THRESHOLD,
    slots: variationSlots(v, SCHOOL_SLOTS),
    matches: matches.map(({ type, key, name }) => ({ type, key, name })),
    previews,
    more: Math.max(0, matches.length - PREVIEW_MAX),
  };
}
