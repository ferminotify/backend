import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIndex, parseTable } from '../utils/timetable/school.js';
import { parseEventsCsv, parseSummary } from '../utils/timetable/variations.js';
import { buildWeek, variationSlots } from '../utils/timetable/merge.js';
import { entityKey } from '../utils/timetable/normalize.js';
import { weekStart, variationsWindow } from '../utils/timetable/index.js';

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
  assert.deepEqual(variationSlots(v('change', '15:30', '17:30')), []);
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

test('buildWeek: other classes and other days are ignored; unmapped events become notes', () => {
  const variations = [
    ev('o', 'CLASSE 2A - AULA 46 - PROF. ESEMPIO', '08:00', '09:00'),
    ev('d', 'CLASSE 1A - AULA 46 - PROF. ESEMPIO', '08:00', '09:00', '2026-10-06'),
    ev('n', 'CLASSE 1A - AULA 40 - STUDIO AUTONOMO', '15:30', '17:30'),
  ];
  const { days } = buildWeek({ entity: { type: 'class', key: '1A', name: '1A' }, table: table1A, variations, days: monday });
  assert.ok(days[0].cells.every((c) => c.status === 'regular'));
  assert.equal(days[0].notes.length, 1);
  assert.equal(days[0].notes[0].uid, 'n');
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

// --- week arithmetic --------------------------------------------------------------

test('weekStart: Monday of the week, next Monday on weekends', () => {
  assert.equal(weekStart('2026-10-07'), '2026-10-05'); // Wednesday
  assert.equal(weekStart('2026-10-05'), '2026-10-05'); // Monday
  assert.equal(weekStart('2026-10-10'), '2026-10-12'); // Saturday
  assert.equal(weekStart('2026-10-11'), '2026-10-12'); // Sunday
  assert.equal(weekStart('2026-10-25'), '2026-10-26'); // DST change weekend
});

test('variationsWindow spans yesterday to today + 3', () => {
  assert.deepEqual(variationsWindow('2026-10-06'), { from: '2026-10-05', to: '2026-10-09' });
});
