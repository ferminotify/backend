// Applies calendar variations to a weekly timetable for one class or room.
import { editDistance, entityKey, sameClassKey, sameRoom, toMinutes } from './normalize.js';
import { levelCovers, splitSegments } from './variations.js';

// Daytime lesson start times. Evening classes add their own (18:15, 19:05, …) from the
// timetable itself. The calendar uses round hours (08:00, 09:00, …); an event time snaps
// to the first slot starting within SNAP_MIN after it (08:00 → 08:05, 14:00 → 14:15).
export const SCHOOL_SLOTS = ['08:05', '09:00', '10:05', '11:00', '12:05', '13:00', '14:15', '15:10'];
const SNAP_MIN = 10;

/**
 * Slots touched by a variation, as start times.
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
  const from = toMinutes(v.start) - SNAP_MIN;
  const to = toMinutes(v.end) - SNAP_MIN;
  return slots.filter((_, i) => mins[i] >= from && mins[i] < to);
}

const CANCELLING = new Set(['entry', 'exit', 'trip', 'off']);

/** Does this variation concern the class? "1QIN" also covers "1QIN gruppo 1/2" (see sameClassKey). */
export function concernsClass(v, classKey) {
  if (v.classes.some((c) => sameClassKey(c, classKey))) return true;
  // Whole years ("CLASSI 1^ LICEO", "TRIENNIO"): same year and track.
  return (v.levels || []).some((l) => levelCovers(l, classKey));
}

export function concernsRoom(v, room) {
  return Boolean(v.room) && sameRoom(v.room, room.name);
}

// Teacher names, word by word: "Del Modello" → ["DEL", "MODELLO"], "Cracò" → ["CRACO"].
const nameWords = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean);

/**
 * Is the teacher (full name from the school site, "Bottazzi Stefano") among the names of an
 * event, which usually carry the surname only ("Bottazzi")? Whole words only, so "Rossi"
 * does not match "Rossini". Two teachers sharing a surname both match, unless an initial
 * tells them apart ("Ferrari F.").
 */
export function mentionsTeacher(names, fullName) {
  const full = nameWords(fullName);
  return (names || []).some((n) => {
    const w = nameWords(n);
    if (!w.length || w.length > full.length) return false;
    // "Verona V.", "Moretti Gr.": an initial after the surname stands for the first name.
    const same = (x, y, i) => x === y || (i > 0 && x.length <= 2 && Boolean(y) && y.startsWith(x));
    const prefix = w.every((x, i) => same(x, full[i], i)); // "Bottazzi" / "Bottazzi Stefano"
    const suffix = w.every((x, i) => x === full[full.length - w.length + i]); // "Stefano Bottazzi" written reversed
    return prefix || (w.length > 1 && suffix) || (w.length === full.length && w.every((x) => full.includes(x)));
  });
}

/**
 * A segment of the title that is only the teacher's name, without "PROF.": "CLASSE 3A - AULA 381 - ROSSI".
 * Whole segments only: a surname anywhere in the text also matches students ("TUTOR ROSSI LINDA"),
 * absent teachers, lists ("AULA 363 A DISPOSIZIONE: …") and plain words ("PANTALONI ROSA").
 */
export function namesTeacherBare(summary, fullName) {
  const full = nameWords(fullName);
  return splitSegments(String(summary).toUpperCase().replace(/\s+/g, ' ').trim()).some((seg) => {
    const w = nameWords(seg.replace(/\([^)]*\)/g, ''));
    return w.length > 0 && w.length < full.length && w.join('').length >= 4 && w.every((x, i) => x === full[i]);
  });
}

// --- Typos in surnames -------------------------------------------------------------
// "PROF. BOTAZZI" may be Bottazzi: one letter off, surnames of 5+ letters, and only when the
// written name is not another teacher's surname (Marini vs Marino stay apart). Only a hint
// for the safety net (a "possible" note), never a cell: a substitute missing from the site's
// list ("ZARDINI") would otherwise land in someone else's timetable.

/**
 * What the safety net knows about the site's teachers: their surnames as joined words
 * ("Del Modello Anna" → DELMODELLO, DEL) and their names word by word.
 */
export function teacherContext(teacherNames = []) {
  const words = teacherNames.map(nameWords);
  const known = new Set();
  for (const w of words) for (let n = 1; n <= Math.max(1, w.length - 1); n++) known.add(w.slice(0, n).join(''));
  return { known, words };
}
const EMPTY_CONTEXT = teacherContext();

const surnameVariants = (fullName) => {
  const w = nameWords(fullName);
  return Array.from({ length: Math.max(1, w.length - 1) }, (_, i) => w.slice(0, i + 1).join('')).filter((k) => k.length >= 5);
};

const oneOff = (written, surname, known) =>
  written.length >= 5 && written !== surname && !known.has(written) && editDistance(written, surname, 1) <= 1;

/** One of the event's names is this teacher's surname with a typo. */
export function mentionsTeacherTypo(names, fullName, ctx = EMPTY_CONTEXT) {
  const surnames = surnameVariants(fullName);
  return (names || []).some((n) => {
    // Prefixes of the written name from its first word ("DE CARLO" is never "CARLO"),
    // without trailing initials ("BOMBANA B." is BOMBANA).
    const w = nameWords(n);
    while (w.length > 1 && w[w.length - 1].length <= 2) w.pop();
    return w.some((_, j) => surnames.some((sur) => oneOff(w.slice(0, j + 1).join(''), sur, ctx.known)));
  });
}

// --- Safety net -------------------------------------------------------------------
// Whatever the parser makes of a title, an event that names the class, the teacher or the
// room somewhere must not disappear: if it was not placed in the timetable it is listed
// with the day's notes, marked `maybe`. A wrong guess costs one line; a missed variation
// costs a student or teacher in the wrong place.

const textWords = (summary) =>
  String(summary || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b([1-5])\s+([A-Z])/g, '$1$2') // "3 CIIN"
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

/** "4CIIN", "4 CIIN", "5C BIO" anywhere in the title ("stampa 3D" is not the 3D). */
export function mentionsClassText(summary, classKey) {
  const key = classKey.replace(/GRUPPO.*$/, '');
  const w = textWords(summary);
  return w.some((x, i) => {
    const hit = x === key || (x + (w[i + 1] || '') === key && /^[1-5][A-Z]{1,3}$/.test(x));
    return hit && !(key === '3D' && /STAMP|MODELL|SCANSION|STAMPANT/.test(w.slice(Math.max(0, i - 3), i + 2).join(' ')));
  });
}

/**
 * The teacher's surname (one or more leading words of the site name, 4+ letters) anywhere,
 * unless the next word names another teacher with that surname ("BOMBANA BENEDETTA",
 * "BOMBANA B." is not Bombana Ivan). Typos are looked for only among the names read as
 * teachers (mentionsTeacherTypo): anywhere in the text, "Radio FERMI" would be Ferri.
 */
export function mentionsTeacherText(summary, fullName, ctx = EMPTY_CONTEXT) {
  const full = nameWords(fullName);
  const w = textWords(summary).map((x) => x.replace(/[^A-Z]/g, ''));
  const fits = (next, first) => Boolean(first) && (first === next || (next.length <= 2 && first.startsWith(next)));
  for (let n = 1; n <= Math.max(1, full.length - 1); n++) {
    const sur = full.slice(0, n);
    if (sur.join('').length < 4) continue;
    const homonyms = ctx.words.filter((o) => o.join(' ') !== full.join(' ') && sur.every((x, j) => o[j] === x));
    for (let i = 0; i < w.length; i++) {
      if (!sur.every((x, j) => w[i + j] === x)) continue;
      const next = w[i + n];
      const other = next && !fits(next, full[n]) && homonyms.some((o) => fits(next, o[n]));
      if (!other) return true;
    }
  }
  return false;
}

/** "AULA 46", "AULE 620/609", "LAB 523": the room's number anywhere. */
export function mentionsRoomText(summary, roomName) {
  const num = String(roomName).match(/\d+/)?.[0];
  if (!num) return false;
  const up = String(summary || '').toUpperCase();
  return [...up.matchAll(/\b(?:AUL[AE]|LAB\w*|PALESTRA|SALA)\s*((?:\d+\s*[/,-]?\s*)+)/g)].some((m) => m[1].match(/\d+/g).includes(num));
}

/**
 * A class code close to this class: a joint class and its parts ("3MENE", "3ITEL" ↔ "3MENEITEL"),
 * or, for codes that match no existing class, one letter off ("4CBIO" ↔ "4ABIO"). Existing
 * classes never count as typos of each other ("2AME" is not "2BME").
 * @param {Set<string>} [known]  keys of the classes on the site
 */
export function nearClassText(summary, classKey, known = new Set()) {
  const key = classKey.replace(/GRUPPO.*$/, '');
  if (key.length < 4) return false;
  return textWords(summary).some((t) => {
    if (!/^[1-5][A-Z]{3,}$/.test(t) || t === key || t[0] !== key[0]) return false;
    if (key.startsWith(t) || key.endsWith(t.slice(1)) || t.startsWith(key)) return true; // joint classes
    return !known.has(t) && editDistance(t, key, 1) <= 1;
  });
}

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

const publicVariation = (v) => ({
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
  // How sure the parser is of its reading (0–100, see confidence.js)
  confidence: v.reading ? v.reading.score : null,
});

/**
 * @param {object} p
 * @param {{type:'class'|'room'|'teacher', key:string, name:string}} p.entity
 * @param {{times:string[], weekdays:number[], lessons:Array}} p.table   from parseTable()
 * @param {Array} p.variations   parsed variations (any date / entity; filtered here)
 * @param {Array<{date:string, weekday:number, published:boolean}>} p.days
 * @param {Set<string>} [p.knownClasses]  keys of the site's classes (for the safety net)
 * @param {object} [p.teachers]  teacherContext() of the site's teachers (for homonyms and typos)
 */
export function buildWeek({ entity, table, variations, days, knownClasses = new Set(), teachers = EMPTY_CONTEXT }) {
  const timesInUse = new Set(table.times);
  // Normally identical to SCHOOL_SLOTS; also keeps any unexpected time the site may add.
  const allSlots = [...new Set([...SCHOOL_SLOTS, ...table.times])].sort((a, b) => toMinutes(a) - toMinutes(b));

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
            status: 'regular',
            variations: [],
          });
        }
      });

    // 2. Variations for this date that concern the entity.
    const todays = variations.filter((v) => v.date === date);
    const notes = [];

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
      } else if (rank(status, extra.occupant) > rank(unit.status, unit.occupant)) {
        unit.status = status;
        Object.assign(unit, extra);
      }
      if (!unit.variations.some((x) => x.uid === v.uid)) unit.variations.push(publicVariation(v));
      timesInUse.add(slot);
    };

    for (const v of todays) {
      // "ANNULLATA …": the variation was called off, the timetable stands.
      if (v.cancelled) continue;
      const slots = variationSlots(v, allSlots);

      if (entity.type === 'class') {
        if (!concernsClass(v, entity.key)) continue;
        if (!slots.length) {
          notes.push(publicVariation(v));
          continue;
        }
        for (const slot of slots) {
          // Entry/exit only matter where there is a lesson to skip.
          if ((v.kind === 'entry' || v.kind === 'exit') && !units.has(slot)) continue;
          touch(slot, v, CANCELLING.has(v.kind) ? 'cancelled' : 'changed');
        }
        continue;
      }

      if (entity.type === 'teacher') {
        const absent = mentionsTeacher(v.absent, entity.name);
        const named = !absent && (mentionsTeacher(v.teachers, entity.name) || namesTeacherBare(v.summary, entity.name));
        if (!slots.length) {
          if (absent || named) notes.push(publicVariation(v));
          continue;
        }
        for (const slot of slots) {
          const base = units.get(slot);
          const sameClass = base?.className && concernsClass(v, entityKey(base.className));
          if (absent) {
            // The teacher is away: their lessons are not held (by them).
            if (base) touch(slot, v, 'cancelled');
          } else if (named) {
            // Substitution, room change or trip duty: the teacher is busy with the event's class.
            const occupant = v.classes.length ? v.classes.join(', ') : v.summary.split(' - ')[0];
            touch(slot, v, 'changed', base && sameClass ? {} : { occupant });
          } else if (sameClass) {
            // The class itself changes: gone (entry/exit/trip) → lesson not held; else show the change.
            touch(slot, v, CANCELLING.has(v.kind) ? 'cancelled' : 'changed');
          }
        }
        continue;
      }

      // Room view.
      if (concernsRoom(v, entity) && !CANCELLING.has(v.kind)) {
        if (!slots.length) {
          notes.push(publicVariation(v));
          continue;
        }
        // Someone is (also) here now: the class(es) or activity named by the event.
        const occupant = v.classes.length ? v.classes.join(', ') : v.summary.split(' - ')[0];
        for (const slot of slots) {
          const base = units.get(slot);
          const sameClass = base && detailClasses(base.detail).some((k) => concernsClass(v, k));
          touch(slot, v, 'changed', base && sameClass ? {} : { occupant });
        }
        continue;
      }
      // A class that normally uses this room moves elsewhere or leaves → room freed.
      if (v.classes.length) {
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

    // Safety net: named in the title but not placed by the reading above.
    for (const v of todays) {
      if (v.cancelled || placed.has(v.uid) || notes.some((n) => n.uid === v.uid)) continue;
      if (mentionsEntityText(v, entity, knownClasses, teachers)) notes.push({ ...publicVariation(v), maybe: true });
    }

    // 3. Collapse consecutive slots of the same lesson with the same outcome into one cell.
    // "Same lesson" = same subject, detail (room/class) and teachers: the school site often
    // lists a double period as two separate one-hour lessons, which should still read as one
    // block. A co-teacher (ITP) present for one of the hours only splits it, so each block
    // tells exactly who is there.
    const cells = [];
    const visible = allSlots.filter((s) => units.has(s) || timesInUse.has(s));
    for (const slot of allSlots) {
      const unit = units.get(slot);
      if (!unit) continue;
      const sig = `${unit.subject}|${unit.detail}|${[...unit.teachers].sort().join(',')}|${unit.status}|${unit.occupant || ''}|${unit.variations.map((v) => v.summary).join('\n')}`;
      const prev = cells[cells.length - 1];
      // Only merge with the cell directly above in the rendered grid.
      const contiguous = prev && visible.indexOf(slot) === visible.indexOf(prev.slots[prev.slots.length - 1]) + 1;
      if (contiguous && prev._sig === sig) {
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
        variations: unit.variations,
      });
    }
    cells.forEach((c) => {
      delete c._sig;
      c.span = c.slots.length;
    });

    return { date, weekday, published, cells, notes };
  });

  const times = allSlots.filter((s) => timesInUse.has(s));
  return { times, days: outDays };
}
