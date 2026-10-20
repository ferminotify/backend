// Keyword matching for notifications, with the timetable's rules (merge.js): a user's
// keyword is usually their class or a teacher's surname, sometimes a room or any word.
//
// - class code ("5CIIN", "5ºCIIN", "3A."): the class named in the title and whole years
//   ("CLASSI PRIME", "TRIENNIO"). Joint classes only as keywords of their own: adding "3MENE"
//   also adds "3MENEITEL" (routes/keyword.js, jointKeywords), and whoever removes it does not
//   want those events;
// - a teacher's surname ("ROSSI", "DEL MODELLO", "PIPPÒ"): the teacher named in the event,
//   present or absent, as /orario reads names;
// - a room ("AULA 94", "LAB 523"): events in that room;
// - always also the keyword's words in the title, so nothing the plain word search found
//   before is lost (symbols and accents aside, now ignored on both sides).
//
// An event that reaches a class only through its year or group ("CLASSI 2^ IT", "TRIENNIO")
// and is an opt-in activity (optIn.js: help desks, tutoring…) is returned apart, under its
// category: the notifier sends it only to users who chose that category.
import { getIndex } from './school.js';
import { parseSummary } from './variations.js';
import { concernsClass, concernsRoom, jointCalendarName, jointClasses, mentionsRoomText, mentionsTeacher, mentionsTeacherText, textWords } from './merge.js';
import { optInCategory } from './optIn.js';
import logger from '../logger.js';

const log = logger.child('timetable:keywords');

/** A keyword's words: "5ºCIIN" → ["5CIIN"], "d'Pluto" → ["D", "PLUTO"], "Pippò" → ["PIPPO"]. */
export function keywordWords(kw) {
  const cleaned = String(kw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ºª°.^]/g, ''); // ordinal marks and dots inside class codes: "5ºCIIN", "3A."
  return textWords(cleaned);
}

/** True when the words of `kw` appear in a row in the title (whole words). */
export function titleHasWords(summary, words) {
  if (!words.length) return false;
  const w = textWords(summary);
  return w.some((_, i) => words.every((x, j) => w[i + j] === x));
}

/**
 * What a keyword stands for, given the school's lists.
 * @returns {{ classKeys: string[], rooms: object[], teachers: string[], words: string[] }}
 */
export function classifyKeyword(kw, { classKeys, rooms, teacherNames }) {
  const words = keywordWords(kw);
  const joined = words.join('');
  const out = { classKeys: [], rooms: [], teachers: [], words };
  if (!words.length) return out;
  if (classKeys.has(joined)) out.classKeys = [joined];
  else {
    // A joint class as the calendar writes it ("5EELEET" for the site's "5EELEEET")
    const joint = [...jointClasses(classKeys)].find(([, parts]) => jointCalendarName(parts) === joined);
    if (joint) out.classKeys = [joint[0]];
  }
  // "AULA 94", "AULA94", "LAB 523": rooms whose name has the same words.
  out.rooms = rooms.filter((r) => keywordWords(r.name).join('') === joined);
  // Surname: the keyword is the first word(s) of the site name ("Rossi Mario"); homonyms all count.
  if (!out.classKeys.length && joined.length >= 3) {
    out.teachers = teacherNames.filter((n) => {
      const full = keywordWords(n);
      return words.length < full.length && words.every((x, i) => full[i] === x);
    });
  }
  return out;
}

/**
 * Does this event (parsed) concern the classified keyword?
 * @returns {false | 'direct' | 'level'} 'level': only through a whole year or group of classes
 */
export function eventMatch(v, k) {
  if (titleHasWords(v.summary, k.words)) return 'direct';
  const named = { ...v, levels: [] };
  if (k.classKeys.some((c) => concernsClass(named, c))) return 'direct';
  if (k.rooms.some((r) => concernsRoom(v, r) || mentionsRoomText(v.summary, r.name))) return 'direct';
  if (k.teachers.some((t) => mentionsTeacher(v.teachers, t) || mentionsTeacher(v.absent, t) || mentionsTeacherText(v.summary, t))) {
    return 'direct';
  }
  if (k.classKeys.some((c) => concernsClass(v, c))) return 'level';
  return false;
}

/** Does this event (parsed) concern the classified keyword, in any way? (/orario's view) */
export const eventMatches = (v, k) => Boolean(eventMatch(v, k));

/**
 * The joint classes a class keyword is part of, to add with it, as the calendar writes
 * them: "5EELE" → ["5EELEET"]. Not a class (surname, room, words): none.
 * @returns {Promise<string[]>}
 */
export async function jointKeywords(kw) {
  const joined = keywordWords(kw).join('');
  const pub = await getIndex();
  const classKeys = new Set(pub.class.map((c) => c.key.toUpperCase()));
  if (!classKeys.has(joined)) return [];
  return [...jointClasses(classKeys)].filter(([, parts]) => parts.includes(joined)).map(([, parts]) => jointCalendarName(parts));
}

/**
 * For each keyword, the uids of the events that concern it: `matches` always notified,
 * `optional` by opt-in category (optIn.js) for users who chose it.
 * @param {{uid:string, summary:string}[]} events
 * @param {string[]} keywords
 * @returns {Promise<{ matches: Record<string, string[]>, optional: Record<string, Record<string, string[]>> }>}
 */
export async function matchKeywords(events, keywords) {
  const pub = await getIndex();
  // Teachers come from the service account; without it, surnames fall back to the word search.
  const priv = await getIndex({ authed: true }).catch((err) => {
    log.warn('Teacher list unavailable, surnames matched as words', { error: err.message });
    return null;
  });
  const lists = {
    classKeys: new Set(pub.class.map((c) => c.key.toUpperCase())),
    rooms: pub.room,
    teacherNames: (priv?.teacher || []).map((t) => t.name).filter((n) => !/\d/.test(n)),
  };
  const parsed = events
    .filter((e) => e && typeof e.uid === 'string' && typeof e.summary === 'string')
    .map((e) => ({ uid: e.uid, summary: e.summary, ...parseSummary(e.summary), optIn: optInCategory(e.summary) }));
  const matches = {};
  const optional = {};
  for (const kw of new Set(keywords)) {
    const k = classifyKeyword(kw, lists);
    matches[kw] = [];
    for (const v of parsed) {
      const how = eventMatch(v, k);
      if (!how) continue;
      if (how === 'direct' || !v.optIn) matches[kw].push(v.uid);
      else if (v.optIn !== 'few') ((optional[kw] ||= {})[v.optIn] ||= []).push(v.uid);
    }
  }
  return { matches, optional };
}
