// Applies calendar variations to a weekly timetable for one class or room.
import { entityKey, toMinutes } from './normalize.js';
import { concernsClass, concernsRoom, EMPTY_CONTEXT, jointsOf, mentionsClassText, mentionsRoomText, mentionsTeacher, mentionsTeacherText, mentionsTeacherTypo, namesTeacherBare, nearClassText } from './match.js';

// Daytime lesson start times. Evening classes add their own (18:15, 19:05, …) from the
// timetable itself. The calendar uses round hours (08:00, 09:00, …); an event time snaps
// to the first slot starting within SNAP_MIN after it (08:00 → 08:05, 14:00 → 14:15).
export const SCHOOL_SLOTS = ['08:05', '09:00', '10:05', '11:00', '12:05', '13:00', '14:15', '15:10'];
const SNAP_MIN = 10;
// The calendar writes round hours for lessons (08:00 for 08:05, 14:00 for 14:15): times within
// this many minutes of the lesson hours mean "those lessons"; further off they are the real times.
const ALIGN_MIN = 15;

// Lessons last 55 minutes (08:05–09:00, 09:00–09:55, break, 10:05–11:00, …, 13:00–13:55, lunch,
// 14:15–15:10, 15:10–16:05); evening ones 50 (18:15–19:05, 19:05–19:55, break, 20:10–21:00, …).
// The school site gives only the start times.
// Evening classes: lessons from here on (first one 18:15).
const EVENING_FROM = '17:45';
const lessonMinutes = (start) => (start >= toMinutes(EVENING_FROM) ? 50 : 55);
const lessonEnd = (mins, i) => mins[i] + lessonMinutes(mins[i]);
const overlap = (a, b, mins, i) => Math.min(b, lessonEnd(mins, i)) - Math.max(a, mins[i]);
const ranged = (v) => !v.allDay && v.start && v.end && v.end > v.start && v.kind !== 'entry' && v.kind !== 'exit';
// Indexes of `slots` with a lesson of the entity that day, in order.
const taughtIdx = (slots, lessonSlots) => slots.map((s, i) => (lessonSlots.has(s) ? i : -1)).filter((i) => i !== -1);

/** Slots starting inside the event, with the round-hour snap (09:00–13:00 → 09:00 … 12:05). */
function startingSlots(v, slots, mins) {
  const from = toMinutes(v.start) - SNAP_MIN;
  const to = toMinutes(v.end) - SNAP_MIN;
  return slots.filter((_, i) => mins[i] >= from && mins[i] < to);
}

/**
 * Does a ranged event line up with lesson hours (start and end within ALIGN_MIN of a lesson's
 * start and end)? 08:00–10:00 does; 10:30–11:30 or 15:00–18:00 do not.
 */
export function alignedToSlots(v, slots = SCHOOL_SLOTS) {
  if (!ranged(v)) return true;
  const mins = slots.map(toMinutes);
  const a = toMinutes(v.start);
  const b = toMinutes(v.end);
  const inside = mins.map((_, i) => i).filter((i) => mins[i] >= a - SNAP_MIN && mins[i] < b - SNAP_MIN);
  return (
    inside.length > 0 &&
    Math.abs(mins[inside[0]] - a) <= ALIGN_MIN &&
    Math.abs(lessonEnd(mins, inside[inside.length - 1]) - b) <= ALIGN_MIN
  );
}

/**
 * Slots touched by a variation, as start times.
 * Lined up with the lesson hours: the lessons starting inside it. Otherwise (real times, e.g.
 * 10:30–11:30): every lesson it overlaps by more than SNAP_MIN.
 * @param {string[]} slots  sorted slot start times of the entity (day + evening classes differ)
 */
export function variationSlots(v, slots = SCHOOL_SLOTS) {
  if (v.allDay) return [...slots];
  const mins = slots.map(toMinutes);
  // Index of the slot an instant (entry/exit time) falls on.
  const t = toMinutes(v.start) - SNAP_MIN;
  let at = mins.findIndex((m) => m >= t);
  if (at === -1) at = slots.length;
  if (v.kind === 'entry') return slots.slice(0, at); // lessons before entering
  if (v.kind === 'exit') return slots.slice(at); // lessons after leaving
  if (v.start === v.end) return at < slots.length ? [slots[at]] : [];
  if (alignedToSlots(v, slots)) return startingSlots(v, slots, mins);
  const a = toMinutes(v.start);
  const b = toMinutes(v.end);
  return slots.filter((_, i) => overlap(a, b, mins, i) > SNAP_MIN);
}

/**
 * Out of the entity's lessons: the event is before the first or after the last lesson of the day,
 * overlaps none of them and does not line up with the school hours (e.g. 15:30–17:30). Then it is
 * shown with its own exact times, as an extra row, instead of on a lesson slot.
 * @param {Set<string>} lessonSlots slots with a lesson of the entity that day
 */
export function offLessons(v, slots, lessonSlots) {
  if (!ranged(v) || alignedToSlots(v, slots)) return false;
  const a = toMinutes(v.start);
  const b = toMinutes(v.end);
  const mins = slots.map(toMinutes);
  if (slots.some((s, i) => lessonSlots.has(s) && overlap(a, b, mins, i) > SNAP_MIN)) return false;
  // Only before the first or after the last lesson of the day: a free hour in between keeps
  // the lesson grid (no odd row between two lessons).
  const taught = taughtIdx(slots, lessonSlots);
  return !(taught.length && b > mins[taught[0]] + SNAP_MIN && a < lessonEnd(mins, taught[taught.length - 1]) - SNAP_MIN);
}

const CANCELLING = new Set(['entry', 'exit', 'trip', 'off']);

// Students staying behind: "CLASSE 5G (ALUNNI NON IN GITA) - AULA 30", "(ALUNNI NON IN VIAGGIO
// D'ISTRUZIONE) - ENTRATA POSTICIPATA". parseSummary keeps that part as the event's group.
const STAYING = /\bNON\b/i;
const forStayers = (v) => STAYING.test(v.group || '');

function mentionsEntityText(v, entity, known, teachers) {
  if (entity.type === 'class') return mentionsClassText(v.summary, entity.key) || nearClassText(v.summary, entity.key, known);
  if (entity.type === 'teacher') {
    return (
      mentionsTeacherText(v.summary, entity.name, teachers) ||
      mentionsTeacherTypo(v.teachers, entity.name, teachers) ||
      mentionsTeacherTypo(v.absent, entity.name, teachers)
    );
  }
  return mentionsRoomText(v.summary, entity.name);
}

// Room view: the detail line holds the class(es), "3AIIN" or "1A, 2A" when shared.
const detailClasses = (detail) => String(detail || '').split(', ').map(entityKey);

// Day or evening lesson hours, by the event's start (when the entity's own are not at hand).
const EVENING_SLOTS = ['18:15', '19:05', '20:10', '21:00', '21:50'];
const slotsOf = (v) => (v.start && v.start >= EVENING_FROM ? EVENING_SLOTS : SCHOOL_SLOTS);

// Who an event puts in a slot: its classes, else the first part of its title.
const occupantOf = (v) => (v.classes.length ? v.classes.join(', ') : v.summary.split(' - ')[0]);

const publicVariation = (v, slots = slotsOf(v)) => ({
  uid: v.uid,
  kind: v.kind,
  label: v.label,
  summary: v.summary,
  classes: v.classes,
  levels: v.levels?.length ? v.levels : undefined,
  group: v.group || null,
  activity: v.activity || null,
  room: v.room,
  teachers: v.teachers,
  absent: v.absent,
  start: v.start,
  end: v.end,
  // Real times, not the lesson hours (10:30–11:30): the cell shows them.
  offGrid: alignedToSlots(v, slots) ? undefined : true,
  // How sure the parser is of its reading (0–100, see assessSummary in parse.js)
  confidence: v.reading ? v.reading.score : null,
});

/**
 * What a changed lesson is, from who teaches it (the rule the secretariat follows):
 * - same teacher (only the room changes) → the same lesson;
 * - another teacher → a substitution ('substitute': no subject, it is not that lesson);
 * - "ANTICIPA 6' ORA" → a later lesson of that teacher moved here ('early': its subject).
 * @param {object} cell     built cell (status 'changed')
 * @param {object[]} dayLessons  lessons of that weekday WITH teachers (logged-in timetable), or []
 * @param {string[]} allSlots
 * @returns {{role: 'substitute'|'early', subject?: string|null} | null}  null: the lesson as it is
 */
export function lessonRole(cell, dayLessons, allSlots) {
  const vs = (cell.variations || []).filter((v) => !CANCELLING.has(v.kind));
  const named = [...new Set(vs.flatMap((v) => v.teachers || []))];
  if (!named.length) return null; // only the room (or the activity) changes
  const teaches = (l) => (l.teachers || []).some((t) => mentionsTeacher(named, t));

  const early = vs.find((v) => /\bANTICIP/i.test(`${v.activity || ''} ${v.summary || ''}`) && !/USCITA/i.test(v.summary || ''));
  if (early) {
    // "ANTICIPA 6' ORA": that hour's lesson; else the teacher's next lesson that day.
    // The hour is counted on the class's own day: evening classes start again from 18:15.
    const hour = Number((`${early.activity || ''} ${early.summary}`.match(/\b(\d)\s*['’^°ªA]?\s*ORA/i) || [])[1]);
    const hours = cell.start >= EVENING_FROM ? allSlots.filter((t) => t >= EVENING_FROM) : allSlots.filter((t) => t < EVENING_FROM);
    const at = hour ? hours[hour - 1] : null;
    const lesson =
      (at && dayLessons.find((l) => l.slots.includes(at) && teaches(l))) ||
      dayLessons.filter((l) => teaches(l) && l.start > cell.start).sort((a, b) => a.start.localeCompare(b.start))[0] ||
      (at && dayLessons.find((l) => l.slots.includes(at)));
    return lesson ? { role: 'early', subject: lesson.subject } : { role: 'substitute' };
  }

  const base = dayLessons.find((l) => l.slots.includes(cell.start));
  if (!base?.teachers?.length) return null; // who teaches it is not known
  // "X (Y ASSENTE)" is mostly a co-teacher away: a substitution only when all of them are.
  const absent = vs.flatMap((v) => v.absent || []);
  const stays = (t) => mentionsTeacher(named, t) || (absent.length > 0 && !mentionsTeacher(absent, t));
  return base.teachers.some(stays) ? null : { role: 'substitute' };
}

/**
 * @param {object} p
 * @param {{type:'class'|'room'|'teacher', key:string, name:string}} p.entity
 * @param {{times:string[], weekdays:number[], lessons:Array}} p.table   from parseTable()
 * @param {Array} p.variations   parsed variations (any date / entity; filtered here)
 * @param {Array<{date:string, weekday:number, published:boolean}>} p.days
 * @param {Set<string>} [p.knownClasses]  keys of the site's classes (for the safety net)
 * @param {object} [p.teachers]  teacherContext() of the site's teachers (for homonyms and typos)
 * @param {object} [p.teacherTable]  same timetable with teachers (logged in), only to tell
 *   substitutions from room changes when `table` has none; never copied into the output
 */
export function buildWeek({ entity, table, variations, days, knownClasses = new Set(), teachers = EMPTY_CONTEXT, teacherTable = null }) {
  // A part of a joint class (3MENE of 3MENEITEL): the joint class's events are its own too.
  const joints = entity.type === 'class' ? jointsOf(entity.key, knownClasses) : [];
  const concernsMe = (v) => concernsClass(v, entity.key) || joints.some((j) => concernsClass(v, j));
  const timesInUse = new Set(table.times);
  // Normally identical to SCHOOL_SLOTS; also keeps any unexpected time the site may add.
  const allSlots = [...new Set([...SCHOOL_SLOTS, ...table.times])].sort((a, b) => toMinutes(a) - toMinutes(b));

  const extraTimes = new Set();
  const outDays = days.map(({ date, weekday, published }) => {
    // 1. Base timetable for this weekday, one unit per slot.
    const units = new Map(); // slot -> unit
    table.lessons
      .filter((l) => l.weekday === weekday)
      .forEach((l) => {
        for (const slot of l.slots) {
          units.set(slot, {
            subject: l.subject,
            detail: l.detail,
            className: l.className || null,
            teachers: l.teachers || [],
            color: l.color,
            jointWith: l.jointWith || null, // lesson of the joint class, with the other part
            status: 'regular',
            variations: [],
          });
        }
      });

    const lessonSlots = new Set(units.keys());
    // The class's school hours that day: first to last lesson. An entry or exit empties them;
    // what comes before or after (help desks, courses, meetings) stays.
    const lessonIdx = taughtIdx(allSlots, lessonSlots);
    const inSchoolHours = (slot) => {
      const i = allSlots.indexOf(slot);
      return lessonIdx.length > 0 && i >= lessonIdx[0] && i <= lessonIdx[lessonIdx.length - 1];
    };
    const overlays = []; // variations with real times, drawn over the lessons
    const extras = new Set(); // exact start times of events out of the lessons

    // 2. Variations for this date that concern the entity.
    // Entries and exits last: they cancel what the other events put in the school hours,
    // whichever order the calendar lists them in.
    const leaves = (v) => v.kind === 'entry' || v.kind === 'exit';
    const todays = variations.filter((v) => v.date === date).sort((a, b) => leaves(a) - leaves(b));
    const notes = [];
    // Part of the class stays at school that day: the class page shows their day (their
    // entry, exit and lessons), the trip of the others is a note, not every lesson cancelled.
    const stayersDay = entity.type === 'class' && todays.some((v) => !v.cancelled && concernsMe(v) && forStayers(v));
    const staysAtSchool = (classKey) => todays.some((v) => !v.cancelled && concernsClass(v, classKey) && forStayers(v));

    // When several variations hit the same slot the strongest outcome wins:
    // a cancellation beats a change; in a room, a class moving in beats the room being freed.
    const rank = (status, occupant) =>
      ({ regular: 0, added: 1, changed: occupant ? 4 : 1, freed: 2, cancelled: 3 })[status];

    const placed = new Set(); // uids shown in a cell or a note
    const touch = (slot, v, status, extra = {}) => {
      placed.add(v.uid);
      let unit = units.get(slot);
      if (!unit) {
        unit = { subject: null, detail: null, className: null, teachers: [], color: null, status: 'added', variations: [] };
        units.set(slot, unit);
        Object.assign(unit, extra);
      } else if (extra.end && unit.end) {
        if (extra.end > unit.end) unit.end = extra.end; // two out-of-lesson events from the same time
      } else if (rank(status, extra.occupant) > rank(unit.status, unit.occupant)) {
        unit.status = status;
        Object.assign(unit, extra);
      }
      if (!unit.variations.some((x) => x.uid === v.uid)) unit.variations.push(publicVariation(v, allSlots));
      timesInUse.add(slot);
      if (extra.end) extras.add(slot); // an extra row only when a cell of this entity uses it
    };

    for (const v of todays) {
      // "ANNULLATA …": the variation was called off, the timetable stands.
      if (v.cancelled) continue;
      // Out of the lessons: one row with the event's own times (see offLessons).
      const exact = offLessons(v, allSlots, lessonSlots);
      const slots = exact ? [v.start] : variationSlots(v, allSlots);
      const at = exact ? { end: v.end } : {};
      // Real times over lessons (10:30–11:30): drawn on top of the timetable at those times,
      // the lessons below unchanged. Not for what takes the class away (it cancels lessons).
      const over = !exact && slots.length > 0 && !v.allDay && v.start !== v.end && !alignedToSlots(v, allSlots) && !CANCELLING.has(v.kind);
      const overlay = (extra = {}) => {
        placed.add(v.uid);
        // The class's own lesson it changes (class view): its subject, room and colour, so the
        // card reads like the lesson moved (room struck through). Elsewhere: who is there.
        const base = !extra.occupant ? slots.map((x) => units.get(x)).find(Boolean) : null;
        overlays.push({
          start: v.start,
          end: v.end,
          slots,
          subject: base?.subject || null,
          detail: base?.detail || null,
          teachers: base ? [...base.teachers] : [],
          color: base?.color || null,
          status: 'changed',
          overlay: true,
          occupant: extra.occupant || null,
          movedTo: null,
          variations: [publicVariation(v, allSlots)],
        });
      };

      if (entity.type === 'class') {
        if (!concernsMe(v)) continue;
        if (!slots.length) {
          notes.push(publicVariation(v, allSlots));
          continue;
        }
        if (v.kind === 'trip' && stayersDay && !forStayers(v)) {
          notes.push(publicVariation(v, allSlots));
          continue;
        }
        if (over) {
          overlay();
          continue;
        }
        for (const slot of slots) {
          // Entry/exit: everything in the school hours (lessons and what other events added
          // there), nothing outside them (a help desk after the last lesson stays). Trips and
          // suspensions: the class's own lessons.
          if (leaves(v) ? !units.has(slot) || !inSchoolHours(slot) : CANCELLING.has(v.kind) && !lessonSlots.has(slot)) continue;
          touch(slot, v, CANCELLING.has(v.kind) ? 'cancelled' : 'changed', at);
        }
        continue;
      }

      if (entity.type === 'teacher') {
        const absent = mentionsTeacher(v.absent, entity.name);
        const named = !absent && (mentionsTeacher(v.teachers, entity.name) || namesTeacherBare(v.summary, entity.name));
        if (!slots.length) {
          if (absent || named) notes.push(publicVariation(v, allSlots));
          continue;
        }
        for (const slot of slots) {
          const base = units.get(slot);
          const sameClass = base?.className && concernsClass(v, entityKey(base.className));
          if (absent) {
            // The teacher is away: their lessons are not held (by them).
            if (base) touch(slot, v, 'cancelled');
          } else if (named && over) {
            overlay({ occupant: occupantOf(v) });
            break;
          } else if (named) {
            // Substitution, room change or trip duty: the teacher is busy with the event's class.
            const occupant = occupantOf(v);
            touch(slot, v, 'changed', base && sameClass ? at : { ...at, occupant });
          } else if (sameClass && v.kind === 'trip' && !forStayers(v) && staysAtSchool(entityKey(base.className))) {
            // The class's trip, but some students stay: the lesson is held for them.
            continue;
          } else if (sameClass) {
            // The class itself changes: gone (entry/exit/trip) → lesson not held. Its lesson
            // given to other teachers, this one not named → this teacher is absent (substituted).
            // A typo of their name is not enough to tell: then just the change.
            // With the absent ones written, the others stay.
            const replaced = v.teachers.length > 0 && !v.absent?.length && !mentionsTeacherTypo(v.teachers, entity.name, teachers);
            touch(slot, v, CANCELLING.has(v.kind) || replaced ? 'cancelled' : 'changed', at);
          }
        }
        continue;
      }

      // Room view.
      if (concernsRoom(v, entity) && !CANCELLING.has(v.kind)) {
        if (!slots.length) {
          notes.push(publicVariation(v, allSlots));
          continue;
        }
        // Someone is (also) here now: the class(es) or activity named by the event.
        const occupant = occupantOf(v);
        if (over) {
          overlay({ occupant });
          continue;
        }
        for (const slot of slots) {
          const base = units.get(slot);
          const sameClass = base && detailClasses(base.detail).some((k) => concernsClass(v, k));
          touch(slot, v, 'changed', base && sameClass ? at : { ...at, occupant });
        }
        continue;
      }
      // A class that normally uses this room moves elsewhere or leaves → room freed.
      if (v.classes.length && !exact) {
        for (const slot of slots) {
          const base = units.get(slot);
          if (!base || base.status === 'added') continue;
          const here = detailClasses(base.detail);
          if (!here.some((k) => concernsClass(v, k))) continue;
          const movesAway = CANCELLING.has(v.kind) || (v.room && !concernsRoom(v, entity));
          // Where the class went: with two events for the lesson (absent teacher, then the new room)
          // the one that moves it decides.
          if (movesAway) touch(slot, v, 'freed', { movedTo: CANCELLING.has(v.kind) ? null : v.room });
        }
      }
    }

    // Safety net: named in the title but not placed by the reading above. In the grid, marked
    // "possible": on a lesson the lesson stays as it is; in a free hour the event itself.
    // Only an instant with no slot stays a note.
    for (const v of todays) {
      if (v.cancelled || placed.has(v.uid) || notes.some((n) => n.uid === v.uid)) continue;
      if (!mentionsEntityText(v, entity, knownClasses, teachers)) continue;
      const pv = { ...publicVariation(v, allSlots), maybe: true };
      // Same placement as the variations above: lesson slots, or its own row out of the lessons.
      const exact = offLessons(v, allSlots, lessonSlots);
      const slots = exact ? [v.start] : variationSlots(v, allSlots);
      if (!slots.length) {
        notes.push(pv);
        continue;
      }
      if (exact) extras.add(v.start);
      for (const slot of slots) {
        let unit = units.get(slot);
        if (!unit) {
          // A free hour: the event itself, flagged possible.
          unit = { subject: null, detail: null, className: null, teachers: [], color: null, status: 'maybe', variations: [], ...(exact ? { end: v.end } : {}) };
          units.set(slot, unit);
          timesInUse.add(slot);
        } else if (unit.status === 'regular') unit.status = 'maybe';
        if (!unit.variations.some((x) => x.uid === v.uid)) unit.variations.push(pv);
      }
    }

    // 3. Collapse consecutive slots of the same lesson with the same outcome into one cell.
    // "Same lesson" = same subject, detail (room/class) and teachers: the school site often
    // lists a double period as two separate one-hour lessons, which should still read as one
    // block. A co-teacher (ITP) present for one of the hours only splits it, so each block
    // tells exactly who is there.
    const cells = [];
    const daySlots = [...new Set([...allSlots, ...extras])].sort((a, b) => toMinutes(a) - toMinutes(b));
    const visible = daySlots.filter((s) => units.has(s) || timesInUse.has(s));
    for (const slot of daySlots) {
      const unit = units.get(slot);
      if (!unit) continue;
      const sig = `${unit.subject}|${unit.detail}|${[...unit.teachers].sort().join(',')}|${unit.status}|${unit.occupant || ''}|${unit.end || ''}|${unit.jointWith || ''}|${unit.variations.map((v) => v.summary).join('\n')}`;
      const prev = cells[cells.length - 1];
      // Only merge with the cell directly above in the rendered grid.
      const contiguous = prev && visible.indexOf(slot) === visible.indexOf(prev.slots[prev.slots.length - 1]) + 1;
      if (contiguous && prev._sig === sig && !unit.end) {
        prev.slots.push(slot);
        continue;
      }
      cells.push({
        _sig: sig,
        start: slot,
        slots: [slot],
        subject: unit.subject,
        detail: unit.detail,
        teachers: [...unit.teachers],
        color: unit.color,
        status: unit.status,
        occupant: unit.occupant || null,
        movedTo: unit.movedTo || null,
        end: unit.end || null, // set only for an out-of-lesson event: its own end time
        jointWith: unit.jointWith || null,
        variations: unit.variations,
      });
    }
    cells.forEach((c) => {
      delete c._sig;
      c.span = c.slots.length;
    });

    // Substitution or anticipated lesson (see lessonRole): lessons with their teachers, from
    // the logged-in timetable when the shown one has none (used here only, not sent).
    if (entity.type === 'class' || entity.type === 'room') {
      const withTeachers = (teacherTable || table).lessons.filter((l) => l.weekday === weekday);
      for (const c of cells) {
        if (c.status !== 'changed' || c.occupant || !c.variations.length) continue;
        const r = lessonRole(c, withTeachers, allSlots);
        if (r) Object.assign(c, { role: r.role, roleSubject: r.subject || null });
      }
    }

    extras.forEach((t) => extraTimes.add(t));
    return { date, weekday, published, cells, overlays, notes };
  });

  // Extra rows (out-of-lesson events) only where some day uses them; flagged for the views.
  const times = [...new Set([...allSlots, ...extraTimes])].filter((s) => timesInUse.has(s)).sort((a, b) => toMinutes(a) - toMinutes(b));
  return { times, extraTimes: times.filter((t) => extraTimes.has(t) && !allSlots.includes(t)), days: outDays };
}
