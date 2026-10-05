// Applies calendar variations to a weekly timetable for one class or room.
import { entityKey, roomNumber, toMinutes } from './normalize.js';

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

const CANCELLING = new Set(['entry', 'exit', 'trip']);

/** Does this variation concern the class? "1QIN" also covers "1QIN gruppo 1/2". */
function concernsClass(v, classKey) {
  return v.classes.some((c) => c === classKey || classKey.startsWith(`${c}GRUPPO`));
}

function concernsRoom(v, room) {
  if (!v.room) return false;
  const num = roomNumber(room.name);
  if (v.roomNumber && num) return v.roomNumber === num;
  return entityKey(v.room) === room.key;
}

const publicVariation = (v) => ({
  uid: v.uid,
  kind: v.kind,
  label: v.label,
  summary: v.summary,
  classes: v.classes,
  room: v.room,
  teachers: v.teachers,
  absent: v.absent,
  start: v.start,
  end: v.end,
});

/**
 * @param {object} p
 * @param {{type:'class'|'room', key:string, name:string}} p.entity
 * @param {{times:string[], weekdays:number[], lessons:Array}} p.table   from parseTable()
 * @param {Array} p.variations   parsed variations (any date / entity; filtered here)
 * @param {Array<{date:string, weekday:number, published:boolean}>} p.days
 */
export function buildWeek({ entity, table, variations, days }) {
  const timesInUse = new Set(table.times);
  // Normally identical to SCHOOL_SLOTS; also keeps any unexpected time the site may add.
  const allSlots = [...new Set([...SCHOOL_SLOTS, ...table.times])].sort((a, b) => toMinutes(a) - toMinutes(b));

  const outDays = days.map(({ date, weekday, published }) => {
    // 1. Base timetable for this weekday, one unit per slot.
    const units = new Map(); // slot -> unit
    table.lessons
      .filter((l) => l.weekday === weekday)
      .forEach((l, n) => {
        for (const slot of l.slots) {
          units.set(slot, {
            lessonId: `${weekday}-${l.start}-${n}`,
            subject: l.subject,
            detail: l.detail,
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

    const touch = (slot, v, status, extra = {}) => {
      let unit = units.get(slot);
      if (!unit) {
        unit = { lessonId: null, subject: null, detail: null, color: null, status: 'added', variations: [] };
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
          const sameClass = base && v.classes.some((c) => entityKey(base.detail) === c);
          touch(slot, v, 'changed', base && sameClass ? {} : { occupant });
        }
        continue;
      }
      // A class that normally uses this room moves elsewhere or leaves → room freed.
      if (v.classes.length) {
        for (const slot of slots) {
          const base = units.get(slot);
          if (!base || base.status === 'added') continue;
          if (!v.classes.some((c) => entityKey(base.detail) === c || entityKey(base.detail).startsWith(`${c}GRUPPO`))) continue;
          const movesAway = CANCELLING.has(v.kind) || (v.room && !concernsRoom(v, entity));
          if (movesAway) touch(slot, v, 'freed');
        }
      }
    }

    // 3. Collapse consecutive slots of the same lesson with the same outcome back into one cell.
    const cells = [];
    const visible = allSlots.filter((s) => units.has(s) || timesInUse.has(s));
    for (const slot of allSlots) {
      const unit = units.get(slot);
      if (!unit) continue;
      const sig = `${unit.lessonId}|${unit.status}|${unit.occupant || ''}|${unit.variations.map((v) => v.summary).join('\n')}`;
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
        color: unit.color,
        status: unit.status,
        occupant: unit.occupant || null,
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
