import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brEntries, parseIndex, parseTable } from '../utils/timetable/school.js';
import { parseEventsCsv, parseSummary } from '../utils/timetable/variations.js';
import { buildWeek, mentionsTeacher, variationSlots } from '../utils/timetable/merge.js';
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
      group: null,
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
  assert.ok(mentionsTeacher(["Cracò"], 'Craco Luca'));
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
    ev('x', 'CLASSE 2A - AULA 46 - PROF. GIALLI', '09:00', '10:00'), // Rossi's class 2A moves room
  ];
  const { days } = buildWeek({ entity, table, variations, days: monday });
  const at = (slot) => cellAt(days[0], slot);
  assert.equal(at('08:05').status, 'cancelled'); // absent
  assert.equal(at('09:00').status, 'changed'); // own class 2A changes
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

test('readingDiffs: parser vs AI reading', async () => {
  const { readingDiffs } = await import('../utils/timetable/index.js');
  const idx = { classes: [{ key: '5EELEEET', name: '5Eeleeet' }, { key: '3AIIN', name: '3Ai in' }] };
  const parsed = parseSummary('CLASSE 5EELEET (ALUNNI IRC) - SALA MENSA - PROF. ROSSI');
  const same = { classes: ['5EELEEET'], kind: 'change', label: null, room: 'Sala Mensa', teachers: ['Mario Rossi'], absent: [] };
  assert.deepEqual(readingDiffs(parsed, same, idx), []);
  const other = { ...same, classes: ['3AIIN'], room: 'Aula 46' };
  assert.deepEqual(readingDiffs(parsed, other, idx).map((d) => d.split(':')[0]), ['classi', 'aula']);
});

test('readingDiffs: name spelling differences are not disagreements', async () => {
  const { readingDiffs } = await import('../utils/timetable/index.js');
  const p = parseSummary("CLASSE 1A - AULA 94 - PROF.ssa VIGHI GIULIA (PROF. D'AMATO: ASSENTE)");
  const ai = { classes: ['1A'], kind: 'change', label: null, room: 'Aula 94', teachers: ['Vighi'], absent: ['Amato'] };
  assert.deepEqual(readingDiffs(p, ai, { classes: [{ key: '1A' }] }), []);
  const q = parseSummary('CLASSE 4AMME - AULA 852 - PROFF. PASETTI, ALEMANNO');
  assert.deepEqual(readingDiffs(q, { classes: ['4AMME'], kind: 'change', room: 'Aula 852', teachers: ['Passetti', 'Alemanno'], absent: [] }, { classes: [] }), []);
  assert.equal(readingDiffs(q, { classes: ['4AMME'], kind: 'change', room: 'Aula 852', teachers: ['Rossi', 'Alemanno'], absent: [] }, { classes: [] }).length, 1);
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
