import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyword, eventMatch, eventMatches, keywordWords } from '../utils/timetable/keywords.js';
import { cleanOptIn, optInCategory } from '../utils/timetable/optIn.js';
import { parseSummary } from '../utils/timetable/variations.js';
import { jointCalendarName } from '../utils/timetable/merge.js';

const lists = {
  classKeys: new Set(['1AIIN', '1BIIN', '3MENE', '3ITEL', '3MENEITEL', '5CIIN']),
  rooms: [{ key: 'AULA94', name: 'Aula 94' }],
  teacherNames: ['Rossi Mario', 'Del Modello Anna', 'Pippò Luca'],
};
const ev = (summary) => ({ uid: summary, summary, ...parseSummary(summary) });
const hit = (kw, summary) => eventMatches(ev(summary), classifyKeyword(kw, lists));

test('keywordWords: symbols and accents of keywords are ignored', () => {
  assert.deepEqual(keywordWords('5ºCIIN'), ['5CIIN']);
  assert.deepEqual(keywordWords('3A.'), ['3A']);
  assert.deepEqual(keywordWords('Pippò'), ['PIPPO']);
  assert.deepEqual(keywordWords('Rossi-Bianchi'), ['ROSSI', 'BIANCHI']);
});

test('keywords: class codes (named, written oddly, whole years; joint classes only as their own keyword)', () => {
  assert.ok(hit('5CIIN', 'CLASSE 5CIIN - AULA 94 - PROF. ROSSI'));
  assert.ok(hit('5ºCIIN', 'CLASSE 5CIIN - AULA 94'));
  assert.ok(hit('1AIIN', 'CLASSI PRIME - ASSEMBLEA IN AULA MAGNA'));
  assert.ok(!hit('3MENE', 'CLASSE 3MENEITEL - AULA 94'));
  assert.ok(hit('3MENEITEL', 'CLASSE 3MENEITEL - AULA 94'));
  assert.equal(jointCalendarName(['5EELE', '5EET']), '5EELEET');
  assert.equal(jointCalendarName(['3MENE', '3ITEL']), '3MENEITEL');
  assert.ok(!hit('1BIIN', 'CLASSE 1AIIN - AULA 94'));
});

test('keywords: surnames, rooms and plain words', () => {
  assert.ok(hit('ROSSI', 'CLASSE 5CIIN - AULA 94 - PROF. ROSSI'));
  assert.ok(hit('PIPPÒ', 'CLASSE 5CIIN - PROF. PIPPO'));
  assert.ok(hit('DEL MODELLO', 'CLASSE 5CIIN - PROF.SSA DEL MODELLO'));
  assert.ok(hit('AULA 94', 'CLASSE 5CIIN - AULA 94'));
  assert.ok(hit('ORIENTAMENTO', 'CLASSE 5CIIN - ORIENTAMENTO IN AULA MAGNA'));
  assert.ok(!hit('ROSSI', 'CLASSE 5CIIN - PROF. BIANCHI'));
  assert.ok(!hit('AULA 9', 'CLASSE 5CIIN - AULA 94'));
});

test('opt-in categories: help desks and the like for a whole year are set apart', () => {
  const how = (kw, summary) => eventMatch(ev(summary), classifyKeyword(kw, lists));
  assert.equal(optInCategory('CLASSI 1^ IT - AULA 10 - SPORTELLO FISICA - PROF. ROSSI'), 'sportelli');
  assert.equal(optInCategory('AULA 6 - PEER TUTORING FISICA - TUTOR MANNA (3A) - CLASSI PRIME'), 'tutoring');
  assert.equal(optInCategory('SALA EROS - OLIMPIADI DELLA MATEMATICA - CLASSI TRIENNIO'), 'olimpiadi');
  assert.equal(optInCategory('AULA 5 - INCONTRO DS CON RAPPRESENTANTI CLASSI 1^'), 'rappresentanti');
  assert.equal(optInCategory('PROGETTO ERASMUS - CLASSI QUARTE IT (2 STUDENTI PER CIASCUNA CLASSE)'), 'few');
  assert.equal(optInCategory('TUTTE LE CLASSI - USCITA ANTICIPATA'), null);
  assert.equal(optInCategory('CLASSI 1^, 2^ IT - PROVA RECUPERO INGLESE'), null);
  // through the year only → 'level'; the class named → 'direct'
  assert.equal(how('1AIIN', 'CLASSI PRIME - SPORTELLO FISICA'), 'level');
  assert.equal(how('1AIIN', 'CLASSE 1AIIN - SPORTELLO FISICA'), 'direct');
  assert.equal(how('1AIIN', 'CLASSI PRIME - ASSEMBLEA IN AULA MAGNA'), 'level');
  assert.deepEqual(cleanOptIn(['sportelli', 'x', 'sportelli', 'few']), ['sportelli']);
});

test('keywords: a joint class as the calendar writes it is the site\'s class', () => {
  const lists = { classKeys: new Set(['5EELE', '5EET', '5EELEEET']), rooms: [], teacherNames: [] };
  const k = classifyKeyword('5EELEET', lists);
  assert.deepEqual(k.classKeys, ['5EELEEET']);
  const ev = (summary) => ({ summary, ...parseSummary(summary) });
  assert.ok(eventMatches(ev('CLASSE 5EELEET (STUDIO ASSISTITO) - AULA 381'), k));
  assert.ok(eventMatches(ev('CLASSE 5EELEEET - AULA 381'), k));
  assert.ok(!eventMatches(ev('CLASSE 5EELEET - AULA 381'), classifyKeyword('5EELE', lists)));
});
