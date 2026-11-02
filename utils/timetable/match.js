// Does an event concern a class, a room or a teacher? The rules shared by the timetable
// (week.js) and the notifications: keyword matching, opt-in activities and the teachers'
// surnames suggested as keywords.
import logger from '../logger.js';
import { calendarEnabled, calendarEventsSince, getVariations, schoolToday } from './calendar.js';
import { baseClassKey, editDistance, plainUpper, roomNumber, sameClassKey, sameRoom, upperText } from './normalize.js';
import { levelCovers, parseSummary, splitSegments } from './parse.js';
import { getIndex } from './school.js';

const log = logger.child('timetable:match');

/** Does this variation concern the class? "1QIN" also covers "1QIN gruppo 1/2" (see sameClassKey). */
export function concernsClass(v, classKey) {
  if (v.classes.some((c) => sameClassKey(c, classKey))) return true;
  // Whole years ("CLASSI 1^ LICEO", "TRIENNIO"): same year and track.
  return (v.levels || []).some((l) => levelCovers(l, classKey));
}

export function concernsRoom(v, room) {
  return Boolean(v.room) && sameRoom(v.room, room.name);
}

// Teacher names, word by word: "Del Modello" → ["DEL", "MODELLO"], "Pippò" → ["PIPPO"].
const nameWords = (s) =>
  plainUpper(s)
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean);

/**
 * Is the teacher (full name from the school site, "Paperone Stefano") among the names of an
 * event, which usually carry the surname only ("Paperone")? Whole words only, so "Rossi"
 * does not match "Rossini". Two teachers sharing a surname both match, unless an initial
 * tells them apart ("Gambadilegno F.").
 */
export function mentionsTeacher(names, fullName) {
  const full = nameWords(fullName);
  return (names || []).some((n) => {
    const w = nameWords(n);
    if (!w.length || w.length > full.length) return false;
    // "Orazio V.", "Basettoni Gr.": an initial after the surname stands for the first name.
    const same = (x, y, i) => x === y || (i > 0 && x.length <= 2 && Boolean(y) && y.startsWith(x));
    const prefix = w.every((x, i) => same(x, full[i], i)); // "Paperone" / "Paperone Stefano"
    const suffix = w.every((x, i) => x === full[full.length - w.length + i]); // "Stefano Paperone" written reversed
    return prefix || (w.length > 1 && suffix) || (w.length === full.length && w.every((x) => full.includes(x)));
  });
}

/**
 * A segment of the title that is only the teacher's name, without "PROF.": "CLASSE 3A - AULA 381 - ROSSI".
 * Whole segments only: a surname anywhere in the text also matches students ("TUTOR ROSSI ANNA"),
 * absent teachers, lists ("AULA 363 A DISPOSIZIONE: …") and plain words ("PANTALONI ROSA").
 */
export function namesTeacherBare(summary, fullName) {
  const full = nameWords(fullName);
  return splitSegments(upperText(summary)).some((seg) => {
    const w = nameWords(seg.replace(/\([^)]*\)/g, ''));
    return w.length > 0 && w.length < full.length && w.join('').length >= 4 && w.every((x, i) => x === full[i]);
  });
}

// --- Typos in surnames -------------------------------------------------------------
// "PROF. PAPEONE" may be Paperone: one letter off, surnames of 5+ letters, and only when the
// written name is not another teacher's surname (Gastoni vs Gastone stay apart). Only a hint
// for the safety net (a "possible" note), never a cell: a substitute missing from the site's
// list ("TAP") would otherwise land in someone else's timetable.

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
export const EMPTY_CONTEXT = teacherContext();

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
    // Prefixes of the written name from its first word ("DE SEMPRONIO" is never "SEMPRONIO"),
    // without trailing initials ("PAPERINA B." is PAPERINA).
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
  plainUpper(summary)
    .replace(/\b([1-5])\s+([A-Z])/g, '$1$2') // "3 CIIN"
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

/** "4CIIN", "4 CIIN", "5C BIO" anywhere in the title ("stampa 3D" is not the 3D). */
export function mentionsClassText(summary, classKey) {
  const key = baseClassKey(classKey);
  const w = textWords(summary);
  return w.some((x, i) => {
    const hit = x === key || (x + (w[i + 1] || '') === key && /^[1-5][A-Z]{1,3}$/.test(x));
    return hit && !(key === '3D' && /STAMP|MODELL|SCANSION|STAMPANT/.test(w.slice(Math.max(0, i - 3), i + 2).join(' ')));
  });
}

/**
 * The teacher's surname (one or more leading words of the site name, 4+ letters) anywhere,
 * unless the next word names another teacher with that surname ("PAPERINA BENEDETTA",
 * "PAPERINA B." is not Paperina Ivan). Typos are looked for only among the names read as
 * teachers (mentionsTeacherTypo): anywhere in the text, "CLUB TOPOLINI" would be Topolino.
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
  const num = roomNumber(roomName);
  if (!num) return false;
  const up = String(summary || '').toUpperCase();
  return [...up.matchAll(/\b(?:AUL[AE]|LAB\w*|PALESTRA|SALA)\s*((?:\d+\s*[/,-]?\s*)+)/g)].some((m) => m[1].match(/\d+/g).includes(num));
}

const jointsByList = new WeakMap(); // class list → its joint classes, computed once per list

/**
 * Joint classes ("classi articolate"), from the class list alone: a code that splits into two
 * existing classes of the same year, the second without its year (3MENEITEL = 3MENE + 3ITEL).
 * Found again every year, nothing to configure. Cached per list object: do not mutate it after.
 * @param {Iterable<string>} known class keys
 * @returns {Map<string, string[]>} joint key → its parts
 */
export function jointClasses(known) {
  const cached = jointsByList.get(known);
  if (cached) return cached;
  const keys = new Set(known);
  const out = new Map();
  for (const k of keys) {
    for (let i = 2; i < k.length - 1; i++) {
      const a = k.slice(0, i);
      const b = k[0] + k.slice(i);
      if (a !== k && keys.has(a) && keys.has(b)) out.set(k, [a, b]);
    }
  }
  jointsByList.set(known, out);
  return out;
}

/**
 * How the calendar writes a joint class: the second part without the year, and without the
 * section letter too when both parts share it ("5EELE" + "5EET" → "5EELEET",
 * "3MENE" + "3ITEL" → "3MENEITEL"); the site says "5EELEEET".
 */
export function jointCalendarName([a, b]) {
  return a + b.slice(a[1] === b[1] ? 2 : 1);
}

/** Joint classes the class is part of: "3ITEL" → ["3MENEITEL"]. */
export function jointsOf(classKey, known) {
  return [...jointClasses(known)].filter(([, parts]) => parts.includes(classKey)).map(([j]) => j);
}

/**
 * A class code close to this class: a joint class and its parts ("3MENE", "3ITEL" ↔ "3MENEITEL"),
 * or, for codes that match no existing class, one letter off ("4CBIO" ↔ "4ABIO"). Existing
 * classes never count as typos of each other ("2AME" is not "2BME").
 * @param {Set<string>} [known]  keys of the classes on the site
 */
export function nearClassText(summary, classKey, known = new Set()) {
  const key = baseClassKey(classKey);
  if (key.length < 4) return false;
  const joint = jointClasses(known);
  return textWords(summary).some((t) => {
    if (!/^[1-5][A-Z]{3,}$/.test(t) || t === key || t[0] !== key[0]) return false;
    // Joint classes: the joint one named on a part's page, or a part on the joint one's page.
    if (joint.get(t)?.includes(key) || joint.get(key)?.includes(t)) return true;
    return !known.has(t) && editDistance(t, key, 1) <= 1;
  });
}

// --- Keywords --------------------------------------------------------------------------------
// Keyword matching for notifications, with the timetable's rules (above): a user's
// keyword is usually their class or a teacher's surname, sometimes a room or any word.
//
// - class code ("5CIIN", "5ºCIIN", "3A."): the class named in the title and whole years
//   ("CLASSI PRIME", "TRIENNIO"). Joint classes only as keywords of their own: adding "3MENE"
//   also adds "3MENEITEL" (routes/keyword.js, jointKeywords), and whoever removes it does not
//   want those events;
// - a teacher's surname ("ROSSI", "DEL MODELLO", "PIPPÒ"): the teacher named in the event,
//   present or absent, as /orario reads names. Surname and first name ("CLARABELLA GIULIA") tell
//   homonyms apart: "CLARABELLA G." and a bare "CLARABELLA" count, "CLARABELLA C." does not;
// - a room ("AULA 94", "LAB 523"): events in that room;
// - always also the keyword's words in the title, so nothing the plain word search found
//   before is lost (symbols and accents aside, now ignored on both sides).
//
// An opt-in activity (below: help desks, tutoring…) that reaches a class keyword, through its
// year or group ("CLASSI 2^ IT") or naming the class itself, is returned apart, under its
// category: the notifier sends it only to users who chose that category.

/** A keyword's words: "5ºCIIN" → ["5CIIN"], "d'Pluto" → ["D", "PLUTO"], "Pippò" → ["PIPPO"]. */
export function keywordWords(kw) {
  // Ordinal marks and dots inside class codes: "5ºCIIN", "3A."
  return textWords(String(kw || '').replace(/[ºª°.^]/g, ''));
}

/** True when the words of `kw` appear in a row in the title (whole words). */
function titleHasWords(summary, words) {
  if (!words.length) return false;
  const w = textWords(summary);
  return w.some((_, i) => words.every((x, j) => w[i + j] === x));
}

/**
 * What a keyword stands for, given the school's lists.
 * `teachers` (teacherContext of teacherNames) may be passed when classifying many keywords.
 * @returns {{ classKeys: string[], rooms: object[], teachers: string[], words: string[], teacherCtx: object }}
 */
export function classifyKeyword(kw, { classKeys, rooms, teacherNames, teachers = null }) {
  const words = keywordWords(kw);
  const joined = words.join('');
  const out = { classKeys: [], rooms: [], teachers: [], words, teacherCtx: teachers || teacherContext(teacherNames) };
  if (!words.length) return out;
  if (classKeys.has(joined)) out.classKeys = [joined];
  else {
    // A joint class as the calendar writes it ("5EELEET" for the site's "5EELEEET")
    const joint = [...jointClasses(classKeys)].find(([, parts]) => jointCalendarName(parts) === joined);
    if (joint) out.classKeys = [joint[0]];
  }
  // "AULA 94", "AULA94", "LAB 523": rooms whose name has the same words.
  out.rooms = rooms.filter((r) => keywordWords(r.name).join('') === joined);
  // Surname: the keyword is the first word(s) of the site name ("Rossi Mario"); homonyms all
  // count. The whole name ("Clarabella Giulia") is that teacher only.
  if (!out.classKeys.length && joined.length >= 3) {
    out.teachers = teacherNames.filter((n) => {
      const full = keywordWords(n);
      return words.length <= full.length && words.every((x, i) => full[i] === x);
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
  if (k.teachers.some((t) => mentionsTeacher(v.teachers, t) || mentionsTeacher(v.absent, t) || mentionsTeacherText(v.summary, t, k.teacherCtx))) {
    return 'direct';
  }
  if (k.classKeys.some((c) => concernsClass(v, c))) return 'level';
  return false;
}

/**
 * The joint classes a class keyword is part of, to add with it, as the calendar writes
 * them: "5EELE" → ["5EELEET"]. Not a class (surname, room, words): none.
 * @returns {Promise<string[]>}
 */
export async function jointKeywords(kw) {
  const joined = keywordWords(kw).join('');
  const classKeys = classKeysOf(await getIndex());
  if (!classKeys.has(joined)) return [];
  return [...jointClasses(classKeys).values()].filter((parts) => parts.includes(joined)).map(jointCalendarName);
}

/** Keys of the classes in a public index (already uppercase, see entityKey). */
const classKeysOf = (pub) => new Set(pub.class.map((c) => c.key));

/**
 * For each keyword, the uids of the events that concern it: `matches` always notified,
 * `optional` by opt-in category (OPT_IN) for users who chose it.
 * @param {{uid:string, summary:string}[]} events
 * @param {string[]} keywords
 * @returns {Promise<{ matches: Record<string, string[]>, optional: Record<string, Record<string, string[]>> }>}
 */
export async function matchKeywords(events, keywords) {
  const pub = await getIndex();
  // Teachers from the cached logged-in index (left by Moodle sessions); none yet: surnames
  // fall back to the word search.
  const priv = await getIndex({ authed: true }).catch((err) => {
    log.warn('Teacher list unavailable, surnames matched as words', { error: err.message });
    return null;
  });
  const lists = {
    classKeys: classKeysOf(pub),
    rooms: pub.room,
    teacherNames: (priv?.teacher || []).map((t) => t.name).filter((n) => !/\d/.test(n)),
  };
  lists.teachers = teacherContext(lists.teacherNames);
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
      // Opt-in activity for a class keyword: only by opt-in, even when the title names the class.
      const byOptIn = v.optIn && v.optIn !== 'few' && (how === 'level' || k.classKeys.length > 0);
      if (byOptIn) ((optional[kw] ||= {})[v.optIn] ||= []).push(v.uid);
      else if (how === 'direct' || !v.optIn) matches[kw].push(v.uid);
    }
  }
  return { matches, optional };
}

// --- Opt-in activities -----------------------------------------------------------------------
// Activities only some students take part in
// notified only to users who opted in (subscribers.notify_optin)

export const OPT_IN = {
  sportelli: {
    label: 'Sportelli',
    example: 'CLASSI 2^ IT - AULA 10 - SPORTELLO FISICA',
    words: [/^SPORTELL/],
  },
  tutoring: {
    label: 'Peer tutoring',
    example: 'PEER TUTORING FISICA - TUTOR (3A) - CLASSI PRIME',
    words: [/^TUTOR/],
  },
  olimpiadi: {
    label: 'Olimpiadi e gare',
    example: 'OLIMPIADI DI INFORMATICA - CLASSI TRIENNIO',
    words: [/^OLIMPIAD/],
  },
  rappresentanti: {
    label: 'Rappresentanti',
    example: 'INCONTRO DS CON RAPPRESENTANTI CLASSI 1^',
    words: [/^RAPPRESENTANT/],
  },
};

// A few students per class ("2 STUDENTI PER CIASCUNA CLASSE", "MAX 3 STUDENTI"): chosen by
// the school, nobody can opt in beforehand. Never notified to a whole year.
const FEW_STUDENTS = /\b\d+\s*(STUDENT|ALUNN)/;

/** Valid opt-in ids only, no duplicates. */
export const cleanOptIn = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => Object.hasOwn(OPT_IN, id)))];

/**
 * The opt-in category of a title, `'few'` for few-students events, or null.
 * @param {string} summary
 */
export function optInCategory(summary) {
  const words = textWords(summary);
  for (const [id, c] of Object.entries(OPT_IN)) {
    if (words.some((w) => c.words.some((re) => re.test(w)))) return id;
  }
  // On the raw title: the words merge "2 STUDENTI" as if it were a class code ("2STUDENTI").
  if (FEW_STUDENTS.test(String(summary || '').toUpperCase())) return 'few';
  return null;
}

// --- Teachers' surnames from the calendar ----------------------------------------------------
// Teachers' surnames as the public calendar prints them ("PROF. ROSSI", "(PROF.ssa DEL
// MODELLO: ASSENTE)"), for keyword suggestions to everyone: the school's own teacher list
// (reserved area) stays for school accounts and Moodle sessions (routes/timetable.js).
//
// Only names after a teacher's title: titles also name students ("TUTOR TIP (3A)")
// and guests ("ING. VERDI"), never listed. A name seen once is likely a typo, left out.
// Read from the start of the school year, once a day, in the background.

const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const MIN_SEEN = 2;

let surnames = []; // last good list
let surnamesAt = 0;
let surnamesFailedAt = 0;
let surnamesLoading = null;

/** 1 September of the school year `today` falls in. */
export function schoolYearStart(today) {
  const [y, m] = today.split('-').map(Number);
  return `${m >= 9 ? y : y - 1}-09-01`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Surnames printed after a teacher's title in these titles, seen at least MIN_SEEN times.
 * "GAMBADILEGNO F." counts as GAMBADILEGNO: the keyword is the surname.
 * @param {string[]} summaries event titles
 * @returns {string[]} upper-case surnames, sorted
 */
export function surnamesFromTitles(summaries) {
  const seen = new Map();
  for (const summary of summaries) {
    const upper = String(summary || '').toUpperCase();
    const p = parseSummary(summary);
    const inTitle = new Set();
    for (const n of [...(p.teachers || []), ...(p.absent || [])]) {
      const name = n.toUpperCase().replace(/\s+[A-Z]\.?$/, '').replace(/\s+/g, ' ').trim();
      if (name.length < 3 || /\d/.test(name)) continue;
      // The name sits in the same segment as a teacher's title: "PROF.", "PROFF.", "PROF.SSA".
      const first = escapeRe(name.split(' ')[0]);
      if (!new RegExp(`\\bPROF[A-Z]*\\.?\\s*[^\\-()]*\\b${first}\\b`).test(upper)) continue;
      inTitle.add(name);
    }
    for (const name of inTitle) seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...seen].filter(([, n]) => n >= MIN_SEEN).map(([name]) => name).sort();
}

async function loadSurnames() {
  const today = schoolToday();
  const events = calendarEnabled()
    ? await calendarEventsSince(schoolYearStart(today))
    : (await getVariations()).variations; // the CSV: only a few days, better than nothing
  const list = surnamesFromTitles(events.map((e) => e.summary));
  if (list.length) {
    surnames = list;
    surnamesAt = Date.now();
  }
  log.info('Calendar surnames', { events: events.length, names: list.length });
}

/**
 * The surnames, never waiting: the first call (and one a day) starts a read in the
 * background and gets the last good list meanwhile ([] right after a restart).
 * @returns {string[]}
 */
export function calendarSurnames() {
  const now = Date.now();
  const stale = now - surnamesAt > REFRESH_MS && now - surnamesFailedAt > RETRY_MS;
  if (stale && !surnamesLoading) {
    surnamesLoading = loadSurnames()
      .catch((err) => {
        surnamesFailedAt = Date.now();
        log.warn('Calendar surnames unavailable', { error: err.message });
      })
      .finally(() => (surnamesLoading = null));
  }
  return surnames;
}
