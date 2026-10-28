import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brEntries, isPlaceholderTeacher, parseIndex, parseTable } from '../utils/timetable/school.js';
import { parseEventsCsv, parseSummary } from '../utils/timetable/variations.js';
import { buildWeek, mentionsClassText, mentionsTeacherTypo, nearClassText, teacherContext, mentionsRoomText, mentionsTeacher, mentionsTeacherText, namesTeacherBare, alignedToSlots, jointClasses, jointsOf, lessonRole, offLessons, SCHOOL_SLOTS, variationSlots } from '../utils/timetable/merge.js';
import { entityKey, sameClassKey, sameRoom } from '../utils/timetable/normalize.js';
import { weekStart, variationsWindow } from '../utils/timetable/index.js';
import { sealTicket, openTicket, TICKET_TTL_MS } from '../utils/schoolTicket.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/timetable/${name}`, import.meta.url), 'utf8');

// --- school site parsing ---------------------------------------------------

test('parseIndex lists classes and rooms with normalised keys', () => {
  const index = parseIndex(fixture('index.html'));
  assert.ok(index.class.length > 100);
  assert.ok(index.room.length > 50);
  assert.deepEqual(index.class[0], { id: '17866', name: '1A', key: '1A' });
  const aiin = index.class.find((c) => c.name === '3Ai in');
  assert.equal(aiin.key, '3AIIN');
});

test('parseTable resolves rowspans into explicit slots', () => {
  const t = parseTable(fixture('class-1A.html'));
  assert.deepEqual(t.weekdays, [1, 2, 3, 4, 5]);
  assert.deepEqual(t.times, ['08:05', '09:00', '10:05', '11:00', '12:05', '13:00']);
  const mondayFirst = t.lessons.find((l) => l.weekday === 1 && l.start === '08:05');
  assert.equal(mondayFirst.subject, 'LINGUA E LETTERATURA ITALIANA');
  assert.equal(mondayFirst.detail, 'Aula 916');
  assert.deepEqual(mondayFirst.slots, ['08:05', '09:00']);
  // A 2-hour lesson on Monday means Monday's second cell is at 10:05, not 09:00.
  assert.ok(!t.lessons.some((l) => l.weekday === 1 && l.start === '09:00'));
  // Every slot of every weekday is covered at most once.
  const seen = new Set();
  for (const l of t.lessons) for (const s of l.slots) {
    const k = `${l.weekday}-${s}`;
    assert.ok(!seen.has(k), `slot ${k} assigned twice`);
    seen.add(k);
  }
});

test('parseTable reads evening timetables with their own times', () => {
  const t = parseTable(fixture('class-evening.html'));
  assert.equal(t.times[0], '18:15');
  assert.ok(t.lessons.every((l) => t.times.includes(l.start)));
});

test('room timetables carry the class as detail', () => {
  const t = parseTable(fixture('room-94.html'));
  assert.ok(t.lessons.length > 0);
  assert.ok(t.lessons.every((l) => /^[1-5]/.test(l.detail)), 'detail should be a class name');
});

test('parseTable on a page without a table returns an empty timetable', () => {
  assert.deepEqual(parseTable('<html></html>'), { times: [], weekdays: [], lessons: [] });
});

// --- calendar titles -----------------------------------------------------------

test('parseSummary: substitution with absent teacher', () => {
  assert.deepEqual(
    parseSummary('CLASSE 3AIIN - AULA 46 - PROFF. ESEMPIO, PROVA, CAMPIONE (PROF.ssa DEL MODELLO: ASSENTE)'),
    {
      classes: ['3AIIN'],
      kind: 'change',
      label: null,
      room: 'Aula 46',
      roomNumber: '46',
      levels: [],
      group: null,
      activity: null,
      cancelled: false,
      teachers: ['Esempio', 'Prova', 'Campione'],
      absent: ['Del Modello'],
    }
  );
});

test('parseSummary: entry, exit, trips', () => {
  assert.equal(parseSummary('CLASSE 1BME - ENTRATA POSTICIPATA').kind, 'entry');
  assert.equal(parseSummary('CLASSE 2F - USCITA ANTICIPATA').kind, 'exit');
  assert.equal(parseSummary('CLASSI 5BMME - USCITA PCTO - PROF.ssa ESEMPIO').kind, 'trip');
  const trip = parseSummary('CLASSI  5MENE, 3LAI, 4ABIO - USCITA DIDATTICA - PROFF. PROVA,CAMPIONE');
  assert.equal(trip.kind, 'trip');
  assert.deepEqual(trip.classes, ['5MENE', '3LAI', '4ABIO']);
  for (const t of ["VIAGGIO D'ISTRUZIONE", 'VIAGGIO D’ISTRUZIONE', 'VIAGGIO DI ISTRUZIONE', 'Viaggio d istruzione']) {
    const v = parseSummary(`CLASSI 4A, 4B - ${t} - PROFF. ESEMPIO`);
    assert.equal(v.kind, 'trip', t);
    assert.equal(v.label, 'Viaggio d’istruzione');
    assert.deepEqual(v.classes, ['4A', '4B']);
  }
  assert.equal(parseSummary("CLASSE 4A - ALUNNI NON IN VIAGGIO D'ISTRUZIONE - ENTRATA POSTICIPATA").kind, 'entry');
  // Typos and plurals still classify.
  assert.equal(parseSummary('CLASSE 2F - USCITA ANTICPATA').kind, 'exit');
  assert.equal(parseSummary('CLASSI 2F, 2G - USCITE ANTICIPATE').kind, 'exit');
  assert.equal(parseSummary('CLASSE 1BME - ENTRATE POSTICIPATE').kind, 'entry');
  assert.equal(parseSummary('CLASSE 1BME - INGRESSO POSTICIPATO').kind, 'entry');
  assert.equal(parseSummary('CLASSE 5C - USCITA DIDATICA').kind, 'trip');
  assert.equal(parseSummary('CLASSE 5C - VIAGIO D’ISTRUZIONE').kind, 'trip');
  assert.equal(parseSummary('CLASSE 3A - STUDIO AUTONMO').kind, 'study');
  // Moving a lesson earlier/later is a plain change, not an exit/entry.
  assert.equal(parseSummary("CLASSE 2LAI - AULA 88 - PROF.ssa ESEMPIO (ANTICIPA 5' ORA)").kind, 'change');
  assert.equal(parseSummary("CLASSE 4EELE - AULA 25 - PROF. ESEMPIO (POSTICIPA 1' ORA)").kind, 'change');
  // Short words stay exact: "PCT" or "PCTA" are not PCTO.
  assert.equal(parseSummary('CLASSE 5C - AULA PCTA').kind, 'change');
  // Students staying behind enter later: entry wins over "uscita didattica".
  assert.equal(parseSummary('CLASSE 4C - ALUNNI NON IN USCITA DIDATTICA - ENTRATA POSTICIPATA').kind, 'entry');
});

test('parseSummary: plural female "PROF.sse", missing dash, IRC note, articulated class', () => {
  assert.deepEqual(parseSummary('CLASSE 5BIIN - AULA 15 - PROF.sse FITTIZIO, IPOTETICO').teachers, ['Fittizio', 'Ipotetico']);
  assert.equal(parseSummary('CLASSE 2A - AULA 46 PROF. ESEMPIO').room, 'Aula 46');
  assert.deepEqual(parseSummary('CLASSE 4C (ALUNNI IRC) - SALA MENSA').classes, ['4C']);
  assert.deepEqual(parseSummary('CLASSE 3EELE EAU - AULA 29 - PROFF. MODELLO').classes, ['3EELEEAU']);
});

test('parseSummary: events without classes', () => {
  const p = parseSummary('AULA 390 - SPORTELLO PSICOLOGICO');
  assert.deepEqual(p.classes, []);
  assert.equal(p.roomNumber, '390');
});

test('parseEventsCsv reads local wall-clock times from the offset string', () => {
  const csv = [
    'uid,summary,description,start.date,start.dateTime,start.timeZone,end.date,end.dateTime,end.timeZone',
    'a1,"CLASSE 1A - AULA 94 - PROF.ssa FITTIZIO",,,2026-10-05T10:00:00+02:00,Europe/Rome,,2026-10-05T11:00:00+02:00,Europe/Rome',
    'a2,"CLASSE 2F - USCITA ANTICIPATA",,,2026-10-05T12:00:00+02:00,Europe/Rome,,2026-10-05T12:00:00+02:00,Europe/Rome',
    'a3,"GITA, ""speciale""",,2026-10-07,,,2026-10-08,,',
  ].join('\n');
  const ev = parseEventsCsv(csv);
  assert.equal(ev.length, 3);
  assert.deepEqual(
    { date: ev[0].date, start: ev[0].start, end: ev[0].end, allDay: ev[0].allDay },
    { date: '2026-10-05', start: '10:00', end: '11:00', allDay: false }
  );
  assert.equal(ev[2].summary, 'GITA, "speciale"');
  assert.equal(ev[2].allDay, true);
});

// --- slot mapping ----------------------------------------------------------------

test('variationSlots snaps round calendar hours onto lesson slots', () => {
  const v = (kind, start, end) => ({ kind, start, end, allDay: false });
  assert.deepEqual(variationSlots(v('change', '08:00', '09:00')), ['08:05']);
  assert.deepEqual(variationSlots(v('change', '09:00', '13:00')), ['09:00', '10:05', '11:00', '12:05']);
  assert.deepEqual(variationSlots(v('change', '13:00', '14:00')), ['13:00']);
  assert.deepEqual(variationSlots(v('entry', '10:00', '10:00')), ['08:05', '09:00']);
  assert.deepEqual(variationSlots(v('exit', '12:00', '12:00')), ['12:05', '13:00', '14:15', '15:10']);
  // Starts mid-lesson, past the last start: the lesson it overlaps.
  assert.deepEqual(variationSlots(v('change', '15:30', '17:30')), ['15:10']);
  assert.deepEqual(variationSlots(v('change', '09:20', '09:50')), ['09:00']);
  // Real times overlapping lessons: every lesson overlapped (not only those starting inside).
  assert.deepEqual(variationSlots(v('change', '10:30', '11:30')), ['10:05', '11:00']);
  assert.deepEqual(variationSlots(v('change', '14:00', '18:00')), ['14:15', '15:10']);
  // Lessons end 55' after the start: 13:30–15:00 covers 25' of the 13:00 lesson, 13:50–15:00 only 5'.
  assert.deepEqual(variationSlots(v('change', '13:30', '15:00')), ['13:00', '14:15']);
  assert.deepEqual(variationSlots(v('change', '13:50', '15:00')), ['14:15']);
  // Outside school hours, or overlapping only a few minutes: no slot (note of the day).
  assert.deepEqual(variationSlots(v('change', '16:30', '18:00')), []);
  assert.deepEqual(variationSlots(v('change', '15:58', '17:00')), []);
  const evening = ['18:15', '19:05', '20:10', '21:00', '21:50'];
  assert.deepEqual(variationSlots(v('change', '18:15', '19:05'), evening), ['18:15']);
});

// --- merge -------------------------------------------------------------------------

const table1A = parseTable(fixture('class-1A.html'));
const ev = (uid, summary, start, end, date = '2026-10-05') => ({
  uid, summary, date, start, end, allDay: false, ...parseSummary(summary),
});
const monday = [{ date: '2026-10-05', weekday: 1, published: true }];
const cellAt = (day, slot) => day.cells.find((c) => c.slots.includes(slot));

test('buildWeek: no variations → cells mirror the timetable', () => {
  const { days, times } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations: [], days: monday });
  assert.deepEqual(times, table1A.times);
  assert.ok(days[0].cells.every((c) => c.status === 'regular'));
  assert.equal(cellAt(days[0], '08:05').span, 2);
});

test('buildWeek: back-to-back one-hour lessons of the same subject and room form one block', () => {
  const lesson = (start, slots, subject, detail) => ({ weekday: 1, start, span: slots.length, slots, subject, detail, color: null });
  const table = {
    times: ['08:05', '09:00', '10:05', '11:00'],
    weekdays: [1],
    lessons: [
      lesson('08:05', ['08:05'], 'MATEMATICA', 'Aula 94'),
      lesson('09:00', ['09:00'], 'MATEMATICA', 'Aula 94'),
      lesson('10:05', ['10:05'], 'MATEMATICA', 'Aula 12'), // other room: separate block
      lesson('11:00', ['11:00'], 'FISICA', 'Aula 12'),
    ],
  };
  const entity = { type: 'class', key: '1A', name: '1A' };
  let { days } = buildWeek({ entity, table, variations: [], days: monday });
  assert.deepEqual(days[0].cells.map((c) => c.slots), [['08:05', '09:00'], ['10:05'], ['11:00']]);

  // A variation on one hour only splits the block again.
  const variations = [ev('x', 'CLASSE 1A - AULA 46 - PROF. ESEMPIO', '09:00', '10:00')];
  ({ days } = buildWeek({ entity, table, variations, days: monday }));
  assert.deepEqual(days[0].cells.map((c) => [c.slots, c.status]), [[['08:05'], 'regular'], [['09:00'], 'changed'], [['10:05'], 'regular'], [['11:00'], 'regular']]);
});

test('buildWeek: a substitution changes only the affected hour of a 2-hour lesson', () => {
  const variations = [ev('x', 'CLASSE 1A - AULA 46 - PROF. ESEMPIO (PROF.ssa IPOTETICO: ASSENTE)', '09:00', '10:00')];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  const first = cellAt(days[0], '08:05');
  const second = cellAt(days[0], '09:00');
  assert.equal(first.status, 'regular');
  assert.equal(first.span, 1);
  assert.equal(second.status, 'changed');
  assert.equal(second.subject, 'LINGUA E LETTERATURA ITALIANA');
  assert.equal(second.variations[0].room, 'Aula 46');
  assert.deepEqual(second.variations[0].absent, ['Ipotetico']);
});

test('buildWeek: late entry cancels earlier lessons, early exit later ones', () => {
  const variations = [
    ev('e', 'CLASSE 1A - ENTRATA POSTICIPATA', '10:00', '10:00'),
    ev('u', 'CLASSE 1A - USCITA ANTICIPATA', '12:00', '12:00'),
  ];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  const status = Object.fromEntries(table1A.times.map((t) => [t, cellAt(days[0], t)?.status]));
  assert.equal(status['08:05'], 'cancelled');
  assert.equal(status['09:00'], 'cancelled');
  assert.equal(status['10:05'], 'regular');
  assert.equal(status['11:00'], 'regular');
  assert.equal(status['12:05'], 'cancelled');
});

test('buildWeek: an early exit empties the school hours, events after them stay', () => {
  const desk = ev('s', 'CLASSI 1^ - AULA 14 - SPORTELLO MATEMATICA - PROF. ESEMPIO', '13:00', '14:00');
  const course = ev('c', 'CLASSE 1A - AULA 20 - CORSO DI RECUPERO - PROF. ESEMPIO', '15:30', '17:00');
  const swap = ev('w', 'CLASSE 1A - AULA 46 - PROF. ESEMPIO', '12:00', '13:00');
  const exit = ev('u', 'CLASSE 1A - USCITA ANTICIPATA', '11:00', '11:00');
  for (const variations of [[exit, desk, course, swap], [desk, course, swap, exit]]) {
    const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
    assert.equal(cellAt(days[0], '11:00')?.status, 'cancelled');
    assert.equal(cellAt(days[0], '12:05')?.status, 'cancelled'); // changed, but the class has left
    assert.equal(cellAt(days[0], '13:00')?.status, 'added'); // after the last lesson: whoever goes
    assert.equal(days[0].cells.find((c) => c.start === '15:30')?.status, 'added');
  }
});

test('buildWeek: a trip with students staying behind shows their day, the trip as a note', () => {
  const variations = [
    { ...ev('t', "CLASSI 1A, 1B - VIAGGIO D'ISTRUZIONE - PROFF. ESEMPIO", null, null), allDay: true },
    ev('e', "CLASSE 1A (ALUNNI NON IN VIAGGIO D'ISTRUZIONE) - ENTRATA POSTICIPATA", '10:00', '10:00'),
    ev('l', "CLASSE 1A (ALUNNI NON IN VIAGGIO D'ISTRUZIONE) - AULA 30 - PROF. ESEMPIO", '10:00', '11:00'),
  ];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.equal(cellAt(days[0], '08:05')?.status, 'cancelled'); // they enter later
  assert.equal(cellAt(days[0], '10:05')?.status, 'changed'); // their lesson in Aula 30
  assert.equal(cellAt(days[0], '11:00')?.status, 'regular');
  assert.deepEqual(days[0].notes.map((n) => n.uid), ['t']);
  // The whole class leaving (nobody staying): every lesson cancelled, as before.
  const all = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations: variations.slice(0, 1), days: monday });
  assert.equal(cellAt(all.days[0], '11:00')?.status, 'cancelled');
});

test('buildWeek: a suspended lesson cancels its hours only', () => {
  const variations = [ev('s', 'CLASSE 1A - LEZIONE DI MATEMATICA SOSPESA', '09:00', '10:00')];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.equal(cellAt(days[0], '08:05')?.status, 'regular');
  assert.equal(cellAt(days[0], '09:00')?.status, 'cancelled');
  assert.equal(cellAt(days[0], '10:05')?.status, 'regular');
});

test('buildWeek: other classes and other days are ignored; unmapped events become notes', () => {
  const variations = [
    ev('o', 'CLASSE 2A - AULA 46 - PROF. ESEMPIO', '08:00', '09:00'),
    ev('d', 'CLASSE 1A - AULA 46 - PROF. ESEMPIO', '08:00', '09:00', '2026-10-06'),
    ev('n', 'CLASSE 1A - ASSEMBLEA DI CLASSE', '17:00', '17:00'), // an instant after the lessons
  ];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.ok(days[0].cells.every((c) => c.status === 'regular'));
  assert.equal(days[0].notes.length, 1);
  assert.equal(days[0].notes[0].uid, 'n');
});

test('buildWeek: an event out of the lessons gets its own row with exact times', () => {
  const last = table1A.lessons.filter((l) => l.weekday === 1).flatMap((l) => l.slots).sort().pop();
  assert.ok(last < '15:10', 'fixture: 1A has no lesson in the last slot on Monday');
  const variations = [ev('x', 'CLASSE 1A - AULA 40 - STUDIO AUTONOMO', '15:30', '17:30')];
  const { days, times, extraTimes } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  const cell = days[0].cells.find((c) => c.start === '15:30');
  assert.equal(cell?.status, 'added');
  assert.equal(cell.end, '17:30');
  assert.ok(times.includes('15:30'));
  assert.deepEqual(extraTimes, ['15:30']);
  assert.equal(days[0].notes.length, 0);
});

test('alignedToSlots: round calendar hours are lesson hours, other times are real', () => {
  const e = (start, end) => ({ kind: 'change', start, end, allDay: false });
  assert.equal(alignedToSlots(e('08:00', '10:00')), true);
  assert.equal(alignedToSlots(e('14:00', '15:00')), true);
  assert.equal(alignedToSlots(e('13:00', '14:00')), true);
  assert.equal(alignedToSlots(e('10:30', '11:30')), false);
  assert.equal(alignedToSlots(e('15:00', '18:00')), false);
  assert.equal(alignedToSlots(e('10:00', '10:00')), true); // an instant: not a range
  assert.equal(alignedToSlots(e('13:00', '14:00')), true); // 13:00–13:55, 5' off
  assert.equal(alignedToSlots(e('09:00', '11:00')), true); // 09:00 → 11:00 (end of the 10:05 lesson)
  // Rooms used by evening classes too: the last day lesson still ends at 16:05.
  assert.equal(alignedToSlots(e('14:00', '16:00'), [...SCHOOL_SLOTS, '18:15', '19:05']), true);
});

test('buildWeek: a variation with real times over lessons is an overlay, lessons unchanged', () => {
  const variations = [ev('r', 'CLASSE 1A - AULA 40 - PROF. ESEMPIO', '08:30', '09:30')];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.ok(days[0].cells.every((c) => c.status === 'regular' && !c.variations.length));
  assert.equal(days[0].overlays.length, 1);
  const o = days[0].overlays[0];
  assert.deepEqual([o.start, o.end, o.slots], ['08:30', '09:30', ['08:05', '09:00']]);
  assert.equal(o.variations[0].offGrid, true);
  assert.equal(days[0].notes.length, 0);
});

test('offLessons: exact times only when no lesson is overlapped and the hours do not line up', () => {
  const lessons = new Set(['08:05', '09:00', '10:05', '11:00', '12:05', '13:00']);
  const e = (start, end, kind = 'change') => ({ kind, start, end, allDay: false });
  assert.equal(offLessons(e('15:30', '17:30'), SCHOOL_SLOTS, lessons), true);
  assert.equal(offLessons(e('16:30', '18:00'), SCHOOL_SLOTS, lessons), true);
  assert.equal(offLessons(e('14:15', '16:05'), SCHOOL_SLOTS, lessons), false); // lines up with the slots
  assert.equal(offLessons(e('14:00', '15:00'), SCHOOL_SLOTS, lessons), false); // snaps to 14:15
  assert.equal(offLessons(e('12:30', '14:00'), SCHOOL_SLOTS, lessons), false); // overlaps a lesson
  assert.equal(offLessons(e('15:30', '17:30'), SCHOOL_SLOTS, new Set([...lessons, '15:10'])), false);
  assert.equal(offLessons(e('16:00', '16:00'), SCHOOL_SLOTS, lessons), false);
  // A free hour between two lessons: stays on the lesson grid.
  assert.equal(offLessons(e('10:30', '11:30'), SCHOOL_SLOTS, new Set(['08:05', '09:00', '12:05'])), false);
  assert.equal(offLessons(e('10:30', '11:30'), SCHOOL_SLOTS, new Set(['08:05', '09:00'])), true);
  assert.equal(offLessons(e('16:00', '16:00', 'exit'), SCHOOL_SLOTS, lessons), false);
});

test('buildWeek: a variation in a free hour adds a cell and its row', () => {
  const variations = [ev('a', 'CLASSE 1A - AULA 40 - PROF. ESEMPIO', '14:00', '15:00')];
  const { days, times } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.ok(times.includes('14:15'));
  assert.equal(cellAt(days[0], '14:15').status, 'added');
});

test('buildWeek: group classes follow variations of the parent class', () => {
  const table = { times: ['08:05'], weekdays: [1], lessons: [{ weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'X', detail: 'Aula 1', color: null }] };
  const variations = [ev('g', 'CLASSE 1QIN - USCITA ANTICIPATA', '08:00', '08:00')];
  const { days } = buildWeek({ entity: { type: 'class', key: '1QINGRUPPO1', name: '1Qin gruppo 1' }, table, variations, days: monday });
  assert.equal(days[0].cells[0].status, 'cancelled');
});

test('buildWeek (room): class moving out frees the room, class moving in occupies it', () => {
  const room = { type: 'room', key: entityKey('Aula 94'), name: 'Aula 94' };
  const table = {
    times: ['08:05', '09:00'],
    weekdays: [1],
    lessons: [
      { weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'MATEMATICA', detail: '3F', color: null },
      { weekday: 1, start: '09:00', span: 1, slots: ['09:00'], subject: 'MATEMATICA', detail: '5C', color: null },
    ],
  };
  const variations = [
    ev('1', 'CLASSE 3F - ENTRATA POSTICIPATA', '09:00', '09:00'),
    ev('2', 'CLASSE 5C - USCITA DIDATTICA', '09:00', '10:00'),
    ev('3', 'CLASSE 2B - AULA 94 - PROF. ESEMPIO', '09:00', '10:00'),
  ];
  const { days } = buildWeek({ entity: room, table, variations, days: monday });
  assert.equal(cellAt(days[0], '08:05').status, 'freed');
  const nine = cellAt(days[0], '09:00');
  assert.equal(nine.status, 'changed');
  assert.equal(nine.occupant, '2B');
  assert.equal(nine.variations.length, 2);
});

test('buildWeek (room): absent teacher in the usual room + new room → freed, moved to the new one', () => {
  const room = { type: 'room', key: entityKey('Aula 94'), name: 'Aula 94' };
  const table = { times: ['08:05'], weekdays: [1], lessons: [{ weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'MATEMATICA', detail: '3F', color: null }] };
  for (const order of [[0, 1], [1, 0]]) {
    const both = [ev('a', 'CLASSE 3F - AULA 94 (PROF. ESEMPIO ASSENTE)', '08:00', '09:00'), ev('b', 'CLASSE 3F - SALA EROS', '08:00', '09:00')];
    const { days } = buildWeek({ entity: room, table, variations: order.map((i) => both[i]), days: monday });
    const cell = cellAt(days[0], '08:05');
    assert.deepEqual([cell.status, cell.movedTo], ['freed', 'Sala Eros']);
  }
});

// --- week arithmetic --------------------------------------------------------------

test('weekStart: Monday of the week, next Monday after the last school day', () => {
  assert.equal(weekStart('2026-10-07'), '2026-10-05'); // Wednesday
  assert.equal(weekStart('2026-10-05'), '2026-10-05'); // Monday
  assert.equal(weekStart('2026-10-10'), '2026-10-12'); // Saturday
  assert.equal(weekStart('2026-10-11'), '2026-10-12'); // Sunday
  assert.equal(weekStart('2026-10-25'), '2026-10-26'); // DST change weekend
  // Saturday lessons: Saturday still shows this week.
  assert.equal(weekStart('2026-10-10', 6), '2026-10-05');
  assert.equal(weekStart('2026-10-11', 6), '2026-10-12');
});

test('variationsWindow spans yesterday to today + 3', () => {
  assert.deepEqual(variationsWindow('2026-10-06'), { from: '2026-10-05', to: '2026-10-09' });
});

// --- teachers (logged-in site) -----------------------------------------------------

// Synthetic pages shaped like the logged-in site: an extra last <p> with teachers.
const cellHtml = (lines) =>
  `<td style="background-color: #fdf2b7"><div class="flex flex-col gap-1">${lines.map((l) => `<p>${l}</p>`).join('')}</div></td>`;
const pageHtml = (rows) => `<table><thead><tr><th></th><th>lunedì</th></tr></thead><tbody>${rows
  .map(([time, lines]) => `<tr><th>${time}</th>${lines ? cellHtml(lines) : '<td></td>'}</tr>`)
  .join('')}</tbody></table>`;

test('parseIndex: teacher list (logged in), names title-cased', () => {
  const html = `<select name="class"><option value="1">1A</option></select><select name="room"></select>
    <select name="teacher"><option value="">--</option><option value="7">ROSSI MARIO</option><option value="8">DEL MODELLO ANNA</option></select>`;
  assert.deepEqual(parseIndex(html).teacher, [
    { id: '7', name: 'Rossi Mario', key: 'ROSSIMARIO' },
    { id: '8', name: 'Del Modello Anna', key: 'DELMODELLOANNA' },
  ]);
  assert.deepEqual(parseIndex(html.replace(/<select name="teacher">[\s\S]*$/, '')).teacher, []);
});

test('parseTable: teachers line only when logged in, per view type', () => {
  const cls = pageHtml([['8:05', ['MATEMATICA', 'Aula 94', 'ROSSI MARIO<br>BIANCHI ANNA']]]);
  const a = parseTable(cls, { type: 'class', withTeachers: true }).lessons[0];
  assert.equal(a.detail, 'Aula 94');
  assert.equal(a.room, 'Aula 94');
  assert.deepEqual(a.teachers, ['Rossi Mario', 'Bianchi Anna']);
  // Public page: two lines, no teachers, nothing mistaken for one.
  const p = parseTable(pageHtml([['8:05', ['MATEMATICA', 'Aula 94']]]), { type: 'class', withTeachers: true }).lessons[0];
  assert.deepEqual(p.teachers, []);
  assert.equal(p.detail, 'Aula 94');

  const room = parseTable(pageHtml([['8:05', ['MATEMATICA', '3F', 'ROSSI MARIO']]]), { type: 'room', withTeachers: true }).lessons[0];
  assert.equal(room.detail, '3F');
  assert.equal(room.className, '3F');

  const t = parseTable(pageHtml([['8:05', ['FISICA', 'Lab 610', '3E et', 'ROSSI MARIO']]]), { type: 'teacher', withTeachers: true }).lessons[0];
  assert.equal(t.detail, '3E et · Lab 610');
  assert.equal(t.className, '3E et');
  assert.equal(t.room, 'Lab 610');
});

test('mentionsTeacher: surname, whole words only', () => {
  assert.ok(mentionsTeacher(['Rossi'], 'Rossi Mario'));
  assert.ok(mentionsTeacher(['Del Modello'], 'Del Modello Anna'));
  assert.ok(mentionsTeacher(['Mario Rossi'], 'Rossi Mario'));
  assert.ok(mentionsTeacher(["Pippò"], 'Pippo Luca'));
  assert.ok(!mentionsTeacher(['Rossi'], 'Rossini Mario'));
  assert.ok(!mentionsTeacher(['Modello'], 'Del Modello Anna'));
  assert.ok(!mentionsTeacher([], 'Rossi Mario'));
});

test('buildWeek: teacher view — absence, substitution elsewhere, class away', () => {
  const table = parseTable(
    pageHtml([
      ['8:05', ['MATEMATICA', 'Aula 94', '3F', 'ROSSI MARIO']],
      ['9:00', ['MATEMATICA', 'Aula 12', '2A', 'ROSSI MARIO']],
      ['10:05', null],
      ['11:00', ['FISICA', 'Aula 18', '4C', 'ROSSI MARIO']],
    ]),
    { type: 'teacher', withTeachers: true }
  );
  const entity = { type: 'teacher', key: 'ROSSIMARIO', name: 'Rossi Mario' };
  const variations = [
    ev('a', 'CLASSE 3F - AULA 94 - PROF. VERDI (PROF. ROSSI: ASSENTE)', '08:00', '09:00'),
    ev('s', 'CLASSE 5B - AULA 40 - PROF. ROSSI', '10:00', '11:00'),
    ev('t', 'CLASSE 4C - USCITA DIDATTICA - PROF. NERI', '11:00', '12:00'),
    ev('x', 'CLASSE 2A - AULA 46 - PROF. GIALLI', '09:00', '10:00'), // Rossi's class 2A given to Gialli
  ];
  const { days } = buildWeek({ entity, table, variations, days: monday });
  const at = (slot) => cellAt(days[0], slot);
  assert.equal(at('08:05').status, 'cancelled'); // absent
  assert.equal(at('09:00').status, 'cancelled'); // own class 2A with another teacher: Rossi absent
  assert.equal(at('10:05').status, 'added'); // substitution in 5B during a free hour
  assert.equal(at('10:05').occupant, '5B');
  assert.equal(at('11:00').status, 'cancelled'); // 4C on a trip
  assert.deepEqual(at('11:00').teachers, ['Rossi Mario']);
});

test('buildWeek: class view keeps teachers per cell and splits blocks by teacher', () => {
  const table = parseTable(
    pageHtml([
      ['8:05', ['MATEMATICA', 'Aula 94', 'ROSSI MARIO']],
      ['9:00', ['MATEMATICA', 'Aula 94', 'ROSSI MARIO']],
      ['10:05', ['MATEMATICA', 'Aula 94', 'BIANCHI ANNA']],
    ]),
    { type: 'class', withTeachers: true }
  );
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table, variations: [], days: monday });
  assert.deepEqual(days[0].cells.map((c) => [c.slots.length, c.teachers]), [[2, ['Rossi Mario']], [1, ['Bianchi Anna']]]);
});

// --- "Accedi con Moodle" ticket ---

test('school ticket round-trips and rejects tampering/expiry', () => {
  process.env.JWT_SECRET ||= 'test-secret';
  const now = 1_700_000_000_000;
  const t = sealTicket({ sessionid: 'abc', csrftoken: 'tok' }, now);
  assert.deepEqual(openTicket(t, now + 1000), { sessionid: 'abc', csrftoken: 'tok' });
  assert.equal(openTicket(t, now + TICKET_TTL_MS + 1), null);
  const raw = Buffer.from(t, 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.equal(openTicket(raw.toString('base64url'), now), null);
  assert.equal(openTicket('garbage', now), null);
  assert.equal(openTicket(t.split('').reverse().join(''), now), null);
});

test('brEntries: "<br> " continues a name, "<br>" starts a new entry', () => {
  assert.deepEqual(brEntries('ROSSI MARIO<br>DEL VERDI<br> ANNA MARIA<br>BIANCHI LUCA'), ['ROSSI MARIO', 'DEL VERDI ANNA MARIA', 'BIANCHI LUCA']);
  assert.deepEqual(brEntries('Aula 1 Disegno B<br>Lab 2 CAD'), ['Aula 1 Disegno B', 'Lab 2 CAD']);
  assert.deepEqual(brEntries('\n  Aula 5\n'), ['Aula 5']);
});

test('a co-teacher present for one hour only splits the block', () => {
  const table = {
    times: ['08:05', '09:00', '10:05'],
    weekdays: [1],
    lessons: [
      { weekday: 1, start: '08:05', slots: ['08:05'], span: 1, subject: 'FISICA', detail: 'Lab 1', teachers: ['Rossi Mario'] },
      { weekday: 1, start: '09:00', slots: ['09:00'], span: 1, subject: 'FISICA', detail: 'Lab 1', teachers: ['Rossi Mario', 'Verdi Anna'] },
      { weekday: 1, start: '10:05', slots: ['10:05'], span: 1, subject: 'FISICA', detail: 'Aula 2', teachers: ['Rossi Mario'] },
    ],
  };
  const { days } = buildWeek({
    entity: { type: 'class', key: '1A', name: '1A' },
    table,
    variations: [],
    days: [{ date: '2026-01-12', weekday: 1, published: true }],
  });
  const cells = days[0].cells;
  assert.deepEqual(
    cells.map((c) => [c.slots, c.teachers]),
    [
      [['08:05'], ['Rossi Mario']],
      [['09:00'], ['Rossi Mario', 'Verdi Anna']],
      [['10:05'], ['Rossi Mario']],
    ]
  );
});

test('sameRoom: calendar room names vs school site names', () => {
  assert.equal(sameRoom('Aula Debate', 'Aula 1-3 Debate'), true);
  assert.equal(sameRoom('Aula 46', 'Aula 46'), true);
  assert.equal(sameRoom('Aula 46', 'Aula 4'), false);
  assert.equal(sameRoom('Aula Vinci3', 'Aula 1-3 Debate'), false);
  assert.equal(sameRoom('Aula Vinci3', 'Vinci 3'), true);
  assert.equal(sameRoom('Sala Mensa', 'Aula 1-3 Debate'), false);
  assert.equal(sameRoom('Palestra', 'Palestra 187'), false);
});

test('buildWeek room view: class moved into a room the calendar names without number', () => {
  const entity = { type: 'room', key: 'AULA13DEBATE', name: 'Aula 1-3 Debate' };
  const table = {
    times: ['12:05', '13:00'],
    weekdays: [5],
    lessons: [{ weekday: 5, slots: ['12:05', '13:00'], subject: 'ELETTROTECNICA', detail: '5E et', teachers: [] }],
  };
  const v = (uid, summary, start, end) => ({ uid, summary, date: '2026-10-09', start, end, allDay: false, ...parseSummary(summary) });
  const week = buildWeek({
    entity,
    table,
    variations: [v('a', 'CLASSE 5EET - AULA DEBATE - PROF. BONESI', '12:00', '13:00'), v('b', 'CLASSE 5EET - SALA MENSA', '13:00', '14:00')],
    days: [{ date: '2026-10-09', weekday: 5, published: true }],
  });
  const [here, away] = week.days[0].cells;
  assert.equal(here.status, 'changed');
  assert.equal(here.occupant, null);
  assert.equal(away.status, 'freed');
});

test('parseSummary: partial group and a dash with a space on one side only', () => {
  const irc = parseSummary('CLASSE 5EELEET (ALUNNI IRC) - SALA MENSA');
  assert.deepEqual(irc.classes, ['5EELEET']);
  assert.equal(irc.group, 'alunni IRC');
  assert.equal(irc.room, 'Sala Mensa');
  const p = parseSummary('CLASSE 3BMME- AULA 360 - PROF.ssa ANNUNZIATA');
  assert.deepEqual(p.classes, ['3BMME']);
  assert.equal(p.roomNumber, '360');
  assert.deepEqual(p.teachers, ['Annunziata']);
  assert.equal(parseSummary('CLASSE 1A - AULA 1-3 DEBATE').room, 'Aula 1-3 Debate');
});

test('sameClassKey: groups, and one letter off only for long articulated names', () => {
  assert.equal(sameClassKey('1QIN', '1QINGRUPPO1'), true);
  assert.equal(sameClassKey('5EELEET', '5EELEEET'), true);
  assert.equal(sameClassKey('3AIIN', '3BIIN'), false);
  assert.equal(sameClassKey('5EELEET', '4EELEEET'), false);
  assert.equal(sameClassKey('5EELE', '5EET'), false);
});

test('assessSummary: well-formed titles stay at 100, problems lower the score', async () => {
  const { assessSummary } = await import('../utils/timetable/confidence.js');
  const index = {
    classes: [{ key: '3AIIN', name: '3Ai in' }, { key: '5EELEEET', name: '5Eeleeet' }, { key: '4EAU', name: '4E au' }],
    rooms: [{ key: 'AULA46', name: 'Aula 46' }, { key: 'AULA13DEBATE', name: 'Aula 1-3 Debate' }],
  };
  const score = (s) => assessSummary(s, parseSummary(s), index);
  assert.equal(score('CLASSE 3AIIN - AULA 46 - PROF. ROSSI (PROF.ssa BIANCHI: ASSENTE)').score, 100);
  assert.equal(score('CLASSE 4EAU - USCITA ANTICIPATA').score, 100);
  assert.equal(score('CLASSE 3AIIN - AULA DEBATE - PROF. ROSSI').score, 100);
  assert.equal(score('CLASSE 3AIIN - SALA MENSA').score, 100); // known place, not an error
  assert.equal(score('COLLEGIO DOCENTI').score, 100); // unrelated event
  const fuzzy = score('CLASSE 5EELEET (ALUNNI IRC) - SALA MENSA');
  assert.equal(fuzzy.score, 85);
  assert.deepEqual(fuzzy.issues.map((i) => i.code), ['class_fuzzy']);
  assert.ok(score('CLASSE 9ZZ - AULA 999').score < 60); // unreadable class + unknown room
  assert.ok(score('CLASSE 4EAU - USCITA ANTICPATA').issues.some((i) => i.code === 'kind_typo'));
  assert.ok(score('3AIIN AULA 46').score <= 50); // no "CLASSE"
});

test('parseSummary: "PROFF.sse" prefix', () => {
  assert.deepEqual(parseSummary('CLASSE 2BME - AULA VINCI3 - PROFF.sse VALLEFUOCO, PASSARELLO').teachers, ['Vallefuoco', 'Passarello']);
  assert.deepEqual(parseSummary('CLASSE 1A - AULA 4 (PROFF.sse ROSSI, VERDI: ASSENTI)').absent, ['Rossi', 'Verdi']);
});

test('toEvents maps Calendar API events: timed, all-day over several days, cancelled', async () => {
  const { toEvents } = await import('../utils/timetable/calendar.js');
  assert.deepEqual(
    toEvents({ id: 'a', summary: ' CLASSE 3A - AULA 46 ', start: { dateTime: '2026-10-05T10:00:00+02:00' }, end: { dateTime: '2026-10-05T12:00:00+02:00' } }),
    [{ uid: 'a', summary: 'CLASSE 3A - AULA 46', date: '2026-10-05', start: '10:00', end: '12:00', allDay: false }]
  );
  const trip = toEvents({ id: 'b', summary: 'CLASSE 5A - VIAGGIO D’ISTRUZIONE', start: { date: '2026-10-07' }, end: { date: '2026-10-10' } });
  assert.deepEqual(trip.map((e) => [e.uid, e.date, e.allDay]), [['b', '2026-10-07', true], ['b@2026-10-08', '2026-10-08', true], ['b@2026-10-09', '2026-10-09', true]]);
  assert.deepEqual(toEvents({ id: 'c', status: 'cancelled', summary: 'X', start: { date: '2026-10-07' } }), []);
  assert.deepEqual(toEvents({ id: 'd', start: { date: '2026-10-07' } }), []);
});

test('parseSummary: students before CLASSE, activity, room first, cancelled', () => {
  const p = parseSummary('ALUNNO B. F. CLASSE 3CIIN - AULA 44 - PROVA RECUPERO STORIA - PROFF. COSTABILE, TONINI');
  assert.deepEqual(
    { classes: p.classes, group: p.group, room: p.room, activity: p.activity, teachers: p.teachers },
    { classes: ['3CIIN'], group: 'alunno B. F.', room: 'Aula 44', activity: 'Prova recupero storia', teachers: ['Costabile', 'Tonini'] }
  );
  const irc = parseSummary('ALUNNI IRC DELLE CLASSI 2BIN, 1B - AULA 360 - PROF. ABATE G.');
  assert.deepEqual([irc.classes, irc.group], [['2BIN', '1B'], 'alunni IRC']);
  assert.deepEqual(parseSummary('AULA 620 - CLASSE 1AME - ASSEMBLEA GENITORI - PROF GHIDINI G.').classes, ['1AME']);
  // A meeting about a class names the class, and the meeting is the activity.
  const council = parseSummary('AULA 5 - CONSIGLIO DI CLASSE 5B');
  assert.deepEqual([council.classes, council.activity], [['5B'], 'Consiglio di classe']);
  const parents = parseSummary('AULA 9 - RIUNIONE GENITORI CLASSE 1AEL');
  assert.deepEqual([parents.classes, parents.activity], [['1AEL'], 'Riunione genitori']);
  assert.equal(parseSummary('CLASSE 3A - PROVA INVALSI MATEMATICA - AULA 46').activity, 'Prova INVALSI matematica');
  const off = parseSummary('ANNULLATA USCITA DIDATTICA - CLASSE 4A - PROFF. PAPAZZONI');
  assert.deepEqual([off.cancelled, off.kind, off.classes], [true, 'trip', ['4A']]);
});

test('parseSummary: class lists, classes late in the title, teachers across dashes', () => {
  const r = (s) => {
    const p = parseSummary(s);
    return { c: p.classes, r: p.room, t: p.teachers, a: p.absent, act: p.activity };
  };
  assert.deepEqual(r('CLASSE 5ITEL + 4ITEL (ALUNNI NON IN GITA) - AULA 19 - PROF. MASTRUZZI S.').c, ['5ITEL', '4ITEL']);
  assert.deepEqual(r('CLASSI 1AME-1EIN - AULA 17 - CORSO RECUPERO INFORMATICA - PROF. BENZI').c, ['1AME', '1EIN']);
  assert.deepEqual(r('CLASSE 3EAU AULA 509 - PROF CARRERO (Prof CARUSO assente)'), { c: ['3EAU'], r: 'Aula 509', t: ['Carrero'], a: ['Caruso'], act: null });
  assert.deepEqual(r('CLASSI 5A - 5B - SALA EROS - SIMULAZIONE 2°PROVA - PROFF. FERRARI S. - MELILEO'), {
    c: ['5A', '5B'], r: 'Sala Eros', t: ['Ferrari S.', 'Melileo'], a: [], act: 'Simulazione 2°PROVA',
  });
  assert.deepEqual(r('AULA 13 - PEER TUTORING MATEMATICA - TUTOR SACCANI - CLASSE 3C'), { c: ['3C'], r: 'Aula 13', t: ['Saccani'], a: [], act: 'Peer tutoring matematica' });
  // Tutors count as teachers; their own class is not involved.
  assert.deepEqual(r('AULA 444 - PEER TUTORING MATEMATICA CLASSE 3MENE - TUTOR TRIVINI 5CBIO'), { c: ['3MENE'], r: 'Aula 444', t: ['Trivini'], a: [], act: 'Peer tutoring matematica' });
  assert.deepEqual(r('AULA 23 - PEER TUTORING INFORMATICA CLASSE 3IIN - TUTOR MARIOTTI CLASSE 3IIN').act, 'Peer tutoring informatica');
  assert.deepEqual(r('AULA 23 - VISIONE PROVE AGOSTO ITALIANO - CLASSI 3EELE, 4CCH A.S. 2025/2026 - PROF.ssa MUSA').c, ['3EELE', '4CCH']);
  assert.deepEqual(r("CLASSE 2AME - AULA 11 - PROF.D'ECCLESIIS (PROF COMUNIAN ASSENTE)").t, ["D'Ecclesiis"]);
  assert.deepEqual(r('CLASSE 5AIIN - AULA 380 - PROFF. SECCHI-ZAINI').t, ['Secchi', 'Zaini']);
  // Titles other than PROF, typos, names inside parentheses or without a title.
  assert.deepEqual(r('CLASSE 3A - AULA 52- PROF ROSSI -MIT DOTT. VERDI').t, ['Rossi', 'Verdi']);
  assert.deepEqual(r('CLASSE 1AME - AULA 8 - INCONTRO - SIG . NERI, PROF. BIANCHI M.').t, ['Neri', 'Bianchi M.']);
  assert.deepEqual(r('CLASSI 3B - AULA 360 - FORMAZIONE SICUREZZA - ING. VERDI (PROFF. ROSSI, BIANCHI)').t, ['Verdi', 'Rossi', 'Bianchi']);
  assert.deepEqual(r('CLASSE 2AEL - AULA DEBATE - PROF- ROSSI').t, ['Rossi']);
  assert.deepEqual(r('CLASSE 3D - AULA DEBATE- PROF. ssa ROSSI').t, ['Rossi']);
  assert.deepEqual(r('CLASSE 3AMME - AULA 443 - INDUSTRIA 4.0 - PROPF. ROSSI').t, ['Rossi']);
  assert.deepEqual(r('CLASSE 4D - AULA 360 - PROGETTO GREEN JOBS - REF. PROFF. ROSSI S. - VERDI').t, ['Rossi S.', 'Verdi']);
  assert.deepEqual(r('CLASSE 4D - 4C - AULA MAGNA- INCONTRO AVIS (Referente prof Rossi)').t, ['Rossi']);
  assert.deepEqual(r('AULA 11 - CONSIGLIO DI CLASSE 1CIN - COORDINATORE PROF. ROSSI').t, ['Rossi']);
  assert.deepEqual(r('AULA 13 - LAVORO DI GRUPPO - REF. ROSSI  CLASSE 4BMME').t, ['Rossi']);
  const speaker = r('CLASSI 5D, 5CCH - AULA MAGNA - "BIOGRAFIE LIRICHE" - E. ROSSI');
  assert.deepEqual([speaker.t, speaker.act], [['E. Rossi'], '"biografie liriche"']);
  const peer = r('CLASSE 3AIIN - AULA 11 - PEER TUTORING INGLESE - ROSSI 5IIN');
  assert.deepEqual([peer.t, peer.act], [['Rossi'], 'Peer tutoring inglese']);
  // Only a tutor's class named: that is the class.
  assert.deepEqual(r('AULA 9 - PEER TUTORING - TUTOR ROSSI CLASSE 3C').c, ['3C']);
  assert.deepEqual(r('AULA 15 - PEER TUTORING INFORMATICA 1CIN - TUTOR ROSSI CLASSE 3IIN').c, ['1CIN']);
  assert.deepEqual(r('CLASSE 1FIN - AULA 2 - PROF. MARSELLA (PROF. CULPO: ASSSENTE)').a, ['Culpo']);
});

test('parseSummary: whole years, evening classes, school staff, visits', async () => {
  const { concernsClass } = await import('../utils/timetable/merge.js');
  const keys = ['1A', '3B', '3AME', '3BMME', '3SMME', '3SIIN', '3BIIN', '4AMME', '4C', '1CIN'];
  const covers = (s) => keys.filter((k) => concernsClass(parseSummary(s), k));
  assert.deepEqual(covers('CLASSI 3^ LICEO - AULA 7 - PROVA COMUNE STORIA'), ['3B']);
  assert.deepEqual(covers('AULA 7 - CLASSI 1^-2^ IT - PROVA RECUPERO STORIA'), ['1CIN']);
  assert.deepEqual(covers('CLASSI 1^ - 2^ LICEO - PROVA INGLESE - AULA 7'), ['1A']);
  assert.deepEqual(covers('CLASSI QUARTE - AULA 360 - PROGETTO'), ['4AMME', '4C']);
  assert.deepEqual(covers('CORSO SERALE - CLASSI TERZE MECCANICA - AULA 15'), ['3SMME']);
  assert.equal(covers('TUTTE LE CLASSI - LECTIO BREVIS- USCITA ANTICIPATA').length, keys.length);
  const tri = parseSummary('AULA 11 - CLASSI TRIENNIO LICEO (in assemblea)  ALUNNI NON PARTECIPANTI - PROF. BRIONI');
  assert.deepEqual([tri.levels.map((l) => l.year), tri.group], [['3', '4', '5'], 'alunni non partecipanti']);
  assert.deepEqual(parseSummary('CLASSE 4B - AULA 98 - COLLABORATORE SCOLASTICO').teachers, ['Collaboratore scolastico']);
  const visit = parseSummary('CLASSI 5MENE - VISITA AZIENDALE PIUSI - SUZZARA - PROFF. GALATI, VOCE');
  assert.deepEqual([visit.kind, visit.teachers], ['trip', ['Galati', 'Voce']]);
  assert.equal(parseSummary("CLASSE 5A (alunni non viaggio d'istruzione)- AULA 88 - PROF. SPAZZINI").kind, 'change');
});

test('parseSummary: suspended lessons, groups of a year, places, notes in parentheses', () => {
  const off = parseSummary('CLASSE 3C - LEZIONE DAD DI FISICA SOSPESA');
  assert.deepEqual([off.kind, off.label, off.activity], ['off', 'Lezione sospesa', 'Lezione DAD di fisica sospesa']);
  const half = parseSummary('AULA MAGNA - PROVA COM. FISICA - CLASSI 1^ IT - SECONDO GRUPPO GRUPPO -PROFF. ROSSI, VERDI');
  assert.deepEqual([half.group, half.activity, half.teachers], ['secondo gruppo', 'Prova com. fisica', ['Rossi', 'Verdi']]);
  const vote = parseSummary('CLASSE 5MME - SEGGIO 4 - VOTAZIONI (vedi sito area STUDENTI)');
  assert.deepEqual([vote.room, vote.activity], ['Seggio 4', 'Votazioni']);
  assert.equal(parseSummary('CLASSE 4MENE - SPETTACOLO TEATRALE - DIFRONTE SALA STAMPA').room, 'Difronte Sala Stampa');
  const tech = parseSummary('CLASSE 3CCH - AULA DEBATE  (con tecnico + 12 Ipad) - PROF. ROSSI');
  assert.deepEqual([tech.room, tech.roomNumber], ['Aula Debate (Con Tecnico + 12 Ipad)', null]);
  assert.equal(parseSummary('AULA 88 - VISIONE PROVE SC. INTEGRATE (CHIMICA) - CLASSI 1AME-1BME - PROF.ssa ROSSI').activity, 'Visione prove sc. integrate (chimica)');
  assert.equal(parseSummary('CLASSE 4B - AULA 96 - PROF. ROSSI (ANTICIPA 6^ ORA)').activity, 'Anticipa 6^ ora');
  const back = parseSummary("AULA 13 - PROVA TP - ALUNNO CLASSE 4EELE RIENTRATO DALL'ANNO ALL'ESTERO- PROFF. ROSSI, VERDI");
  assert.deepEqual([back.classes, back.group, back.teachers], [['4EELE'], "alunno rientrato dall'anno all'estero", ['Rossi', 'Verdi']]);
  const ref = parseSummary('AULA 50 - LAVORO DI GRUPPO - REF. ALUNNO ROSSI CLASSE 2AEL');
  assert.deepEqual([ref.classes, ref.group, ref.teachers], [['2AEL'], null, ['Alunno Rossi']]);
});

test('teacher matching: initials, names after a comma, bare surnames, typos', () => {
  assert.ok(mentionsTeacher(['Verdi V.'], 'Verdi Valentina'));
  assert.ok(!mentionsTeacher(['Verdi V.'], 'Verdi Gianni'));
  assert.ok(mentionsTeacher(['Moretti Gr.'], 'Moretti Graziella'));
  const p = parseSummary('A.2.1 - AI PER DOCENTI STEM – I CICLO 10h, PROF. PAOLO ROSSI - AULA 11');
  assert.ok(mentionsTeacher(p.teachers, 'Rossi Paolo'));
  assert.equal(p.room, 'Aula 11');
  assert.deepEqual(parseSummary('CLASSE 4AIIN - AULA 380 PROFF. ROSSI, VERDI (PROF. NERI ASSENTE)').teachers, ['Rossi', 'Verdi']);
  assert.deepEqual(parseSummary('CLASSE 5EELE - AULA 360 - PROF, ROSSI').teachers, ['Rossi']);
  assert.deepEqual(parseSummary('CLASSE 2BCH - AULA DEBATE - PRO. ROSSI').teachers, ['Rossi']);
  assert.deepEqual(parseSummary('CLASSE 5ACCH - AULA 92 - PROFF. ROSSI + STUDENTE MIT').teachers, ['Rossi']);
  assert.deepEqual(parseSummary('CLASSE 4BMME - AULA 438 - PROF. ROSSI (PROF. VERDI ASENTE)').absent, ['Verdi']);
  assert.deepEqual(parseSummary('CLASSE 4AIIN - AULA 17 - PROF.ssa ROSSI (PROFF. VERDI e NERI: ASSENTI)').absent, ['Verdi', 'Neri']);
  const off = parseSummary('CLASSI 3^ LICEO - AULA 20 - SPORTELLO MATEMATICA - PROF. ROSSI ANNULLATO');
  assert.deepEqual([off.cancelled, off.teachers], [true, ['Rossi']]);
  assert.ok(namesTeacherBare('CLASSE 3A - AULA 381 - ROSSI', 'Rossi Mario'));
  assert.ok(!namesTeacherBare('AULA 42 - PEER TUTORING - TUTOR ROSSI LINDA (4AIIN) - CLASSE 4AIIN', 'Rossi Mario'));
  assert.ok(!namesTeacherBare('AULA 363 A DISPOSIZIONE: ROSSI VERDI NERI', 'Rossi Mario'));
});

test('parseSummary: "CLASSE" with typos, a class written after AULA, rooms after the class', () => {
  for (const t of ['CLASE 4CIIN - AULA 380 - PROF. ROSSI', 'CLSSE 4CIIN - AULA 380', 'CLASS 4CIIN - AULA 380', 'CLADDE 4CIIN - AULA 380']) {
    assert.deepEqual(parseSummary(t).classes, ['4CIIN'], t);
  }
  assert.deepEqual(parseSummary('AULA 4CCH - AULA 29 - PROF. ROSSI').classes, ['4CCH']);
  assert.equal(parseSummary('AULA 4CCH - AULA 29 - PROF. ROSSI').room, 'Aula 29');
  assert.deepEqual(parseSummary('CLASSE 2AEL AULE 620/609 - PROF. ROSSI').classes, ['2AEL']);
});

test('safety net: an event naming the class / teacher / room is never lost', () => {
  assert.ok(mentionsClassText('AULA 414 - ORIENTAMENTO 3BMME - PROF. ROSSI', '3BMME'));
  assert.ok(mentionsClassText('AULA 9 - CLASSE 3 CIIN', '3CIIN'));
  assert.ok(mentionsClassText('CLASSE 5C BIO - AULA 9', '5CBIO'));
  assert.ok(!mentionsClassText('FABLAB - CORSO STAMPA 3D - PROF. ROSSI', '3D'));
  assert.ok(!mentionsClassText('CLASSE 3DIN - AULA 9', '3D'));
  assert.ok(mentionsTeacherText('AULA 363 A DISPOSIZIONE: VERDI ROSSI NERI', 'Rossi Mario'));
  assert.ok(mentionsTeacherText('CLASSE 3A - PROF. DEL MODELLO', 'Del Modello Anna'));
  assert.ok(!mentionsTeacherText('CLASSE 3A - PROF. ROSSINI', 'Rossi Mario'));
  assert.ok(mentionsRoomText('CLASSE 2AEL AULE 620/609 - PROF. ROSSI', 'Aula 609'));
  const known = new Set(['2AME', '2BME', '4ABIO', '4BBIO', '3MENE', '3ITEL', '3MENEITEL']);
  assert.ok(nearClassText('CLASSE 4CBIO - AULA 12', '4ABIO', known)); // no 4CBIO: one letter off
  assert.ok(!nearClassText('CLASSE 2AME - AULA 12', '2BME', known)); // 2AME exists
  assert.ok(nearClassText('CLASSE 3MENE - AULA 12', '3MENEITEL', known)); // part of a joint class
  assert.ok(nearClassText('CLASSE 3ITEL - AULA 12', '3MENEITEL', known));
  assert.ok(nearClassText('CLASSE 3MENEITEL - SALA EROS', '3ITEL', known)); // the second part too
  assert.ok(nearClassText('CLASSE 3MENEITEL - SALA EROS', '3MENE', known));

  const v = [ev('m', 'AULA 414 - ORIENTAMENTO 3BMME - PROF. ESEMPIO', '08:00', '09:00')];
  const cls = buildWeek({ entity: { type: 'class', key: '3BMME', name: '3BMME' }, table: table1A, variations: v, days: monday });
  // On the lesson it covers: marked possible, the lesson kept; no note.
  assert.equal(cellAt(cls.days[0], '08:05').status, 'maybe');
  assert.deepEqual(cellAt(cls.days[0], '08:05').variations.map((x) => [x.uid, x.maybe]), [['m', true]]);
  assert.equal(cls.days[0].notes.length, 0);
  // No lesson then: the event itself in the grid, flagged possible.
  const free = buildWeek({ entity: { type: 'class', key: '3BMME', name: '3BMME' }, table: table1A, variations: [ev('f', 'AULA 414 - ORIENTAMENTO 3BMME', '14:00', '15:00')], days: monday });
  assert.equal(cellAt(free.days[0], '14:15')?.status, 'maybe');
  assert.equal(cellAt(free.days[0], '14:15').subject, null);
  assert.equal(free.days[0].notes.length, 0);
  // An instant with no slot: still a note.
  const instant = buildWeek({ entity: { type: 'class', key: '3BMME', name: '3BMME' }, table: table1A, variations: [ev('i', 'AULA 414 - ORIENTAMENTO 3BMME', '17:00', '17:00')], days: monday });
  assert.deepEqual(instant.days[0].notes.map((n) => [n.uid, n.maybe]), [['i', true]]);
  // Placed in a cell: not repeated as a note.
  const placed = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations: [ev('p', 'CLASSE 1A - AULA 40 - PROF. ESEMPIO', '08:00', '09:00')], days: monday });
  assert.equal(placed.days[0].notes.length, 0);
});

test('teacher surnames with typos', () => {
  const known = teacherContext(['Bottazzi Stefano', 'Marini Luca', 'Marino Anna', 'Del Modello Anna', 'Sai Paolo']);
  assert.ok(mentionsTeacherTypo(['Botazzi'], 'Bottazzi Stefano', known));
  assert.ok(mentionsTeacherTypo(['Bottazi S.'], 'Bottazzi Stefano', known));
  assert.ok(mentionsTeacherTypo(['Del Modelo'], 'Del Modello Anna', known));
  assert.ok(!mentionsTeacherTypo(['Marini'], 'Marino Anna', known)); // another teacher
  assert.ok(!mentionsTeacherTypo(['Sau'], 'Sai Paolo', known)); // too short to guess
  assert.ok(!mentionsTeacherTypo(['De Carlo'], 'Carli Rita', teacherContext(['De Carlo Anna', 'Carli Rita'])));
  assert.ok(!mentionsTeacherText('AULA 375 - RIUNIONE RADIO FERMI - REF. PROF. ROSSI', 'Ferri Luca', teacherContext(['Ferri Luca']))); // a word, not a teacher

  const teacher = { type: 'teacher', key: 'BOTTAZZISTEFANO', name: 'Bottazzi Stefano' };
  const table = { times: ['08:05'], weekdays: [1], lessons: [{ weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'TPS', detail: '3A · Aula 9', className: '3A', color: null }] };
  assert.ok(!mentionsTeacherTypo(['Bombana B.'], 'Bombani Ivan', teacherContext(['Bombana Benedetta', 'Bombani Ivan']))); // other teacher
  assert.ok(!mentionsTeacherTypo(['Verona V.'], 'Veronav Ugo', teacherContext(['Verona Valentina', 'Veronav Ugo']))); // initials apart
  const homonyms = teacherContext(['Bombana Benedetta', 'Bombana Ivan', 'De Carlo Anna', 'Carli Rita']);
  assert.ok(!mentionsTeacherText('PROF.ssa BOMBANA BENEDETTA', 'Bombana Ivan', homonyms));
  assert.ok(!mentionsTeacherText('PROF. BOMBANA B.', 'Bombana Ivan', homonyms));
  assert.ok(mentionsTeacherText('PROF. BOMBANA', 'Bombana Ivan', homonyms));
  assert.ok(mentionsTeacherText('PROF. BOMBANA I.', 'Bombana Ivan', homonyms));
  // A typo only marks the lesson "possible": never cancels or changes it.
  const week = buildWeek({ entity: teacher, table, variations: [ev('a', 'CLASSE 5B - AULA 9 - PROF. ROSSI (PROF. BOTAZZI ASSENTE)', '08:00', '09:00')], days: monday, teachers: known });
  assert.equal(cellAt(week.days[0], '08:05').status, 'maybe');
  assert.deepEqual(cellAt(week.days[0], '08:05').variations.map((n) => n.maybe), [true]);
});

test('lessonRole: same teacher = same lesson, another = substitution, ANTICIPA = the later lesson', () => {
  const slots = SCHOOL_SLOTS;
  const lessons = [
    { weekday: 1, start: '08:05', slots: ['08:05'], subject: 'MATEMATICA', teachers: ['Rossi Mario'] },
    { weekday: 1, start: '13:00', slots: ['13:00'], subject: 'STORIA', teachers: ['Giammanco Anna'] },
  ];
  const cell = (summary) => ({ start: '08:05', status: 'changed', variations: [{ kind: 'change', summary, ...parseSummary(summary) }] });
  assert.equal(lessonRole(cell('CLASSE 1A - AULA 46'), lessons, slots), null); // room only
  assert.equal(lessonRole(cell('CLASSE 1A - AULA 46 - PROF. ROSSI'), lessons, slots), null); // same teacher
  assert.deepEqual(lessonRole(cell('CLASSE 1A - AULA 46 - PROF. VERDI'), lessons, slots), { role: 'substitute' });
  assert.deepEqual(lessonRole(cell("CLASSE 1A - AULA 918 - PROF.ssa GIAMMANCO (ANTICIPA 6' ORA)"), lessons, slots), { role: 'early', subject: 'STORIA' });
  // Teachers unknown: an absent one means a substitution, otherwise the lesson as it is.
  assert.deepEqual(lessonRole(cell('CLASSE 1A - AULA 46 - PROF. VERDI (PROF. ROSSI: ASSENTE)'), [], slots), { role: 'substitute' });
  assert.equal(lessonRole(cell('CLASSE 1A - AULA 46 - PROF. VERDI'), [], slots), null);
});

test('joint classes are found from the class list alone', () => {
  const known = ['3MENE', '3ITEL', '3MENEITEL', '5EELE', '5EET', '5EELEEET', '3A', '3AIN', '1QIN', '1QINGRUPPO1'];
  assert.deepEqual(Object.fromEntries(jointClasses(known)), { '3MENEITEL': ['3MENE', '3ITEL'], '5EELEEET': ['5EELE', '5EET'] });
  assert.deepEqual(jointsOf('3ITEL', known), ['3MENEITEL']);
  assert.deepEqual(jointsOf('3A', known), []);
});

test('buildWeek: a part of a joint class takes the joint class events as its own', () => {
  const known = new Set(['3MENE', '3ITEL', '3MENEITEL']);
  const table = { times: ['08:05'], weekdays: [1], lessons: [{ weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'X', detail: 'Aula 1', color: null, jointWith: '3Mene' }] };
  const variations = [ev('j', 'CLASSE 3MENEITEL - SALA EROS', '08:00', '09:00')];
  const { days } = buildWeek({ entity: { type: 'class', key: '3ITEL', name: '3Itel' }, table, variations, days: monday, knownClasses: known });
  assert.equal(days[0].cells[0].status, 'changed');
  assert.equal(days[0].cells[0].jointWith, '3Mene');
});

test('buildWeek (teacher): own class given to another teacher → absent', () => {
  const teacher = { type: 'teacher', key: 'CULPOMARIO', name: 'Culpo Mario' };
  const table = { times: ['08:05'], weekdays: [1], lessons: [{ weekday: 1, start: '08:05', span: 1, slots: ['08:05'], subject: 'GPOI', detail: '5Bi in · Aula 2', className: '5BIIN', color: null }] };
  const other = buildWeek({ entity: teacher, table, variations: [ev('r', 'CLASSE 5BIIN - AULA 2- PROF.ssa RAVANINI', '11:00', '12:00')].map((x) => ({ ...x, start: '08:00', end: '09:00' })), days: monday });
  assert.equal(other.days[0].cells[0].status, 'cancelled');
  // Only the room changes (no teacher named): still their lesson.
  const room = buildWeek({ entity: teacher, table, variations: [ev('m', 'CLASSE 5BIIN - AULA 40', '08:00', '09:00')], days: monday });
  assert.equal(room.days[0].cells[0].status, 'changed');
});

test('isPlaceholderTeacher: unassigned chairs, not people', () => {
  for (const n of ['A40 Catt 1', 'A40 Coe 3d', 'A42 CATT 1', 'B016 CATT 2']) assert.equal(isPlaceholderTeacher(n), true, n);
  for (const n of ['Cattini Sara', 'Abate Isabella', 'Del Proposto, Luigino Giovanni']) assert.equal(isPlaceholderTeacher(n), false, n);
});
