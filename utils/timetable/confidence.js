// How sure we are that an event title was read right: 0–100.
// Starts from 100; each problem found takes points off. A well-formed title whose classes
// and rooms all exist on the school timetable stays at 100.
import { kindHasTypo, matchKind, ROOM_RE } from './variations.js';
import { entityKey, sameClassKey, sameRoom } from './normalize.js';

export const AI_THRESHOLD = Number(process.env.AI_CONFIDENCE_THRESHOLD) || 60;

// Places named by the calendar that are not on the timetable site: not an error.
const KNOWN_PLACES = /\b(MENSA|AULA MAGNA|BIBLIOTECA|AUDITORIUM|CORTILE|PALESTRA|PALAZZETTO|TEATRO)\b/;

// Class-like token: "3AIIN", "5EELEET", "1A".
const CLASS_TOKEN = /\b[1-5][A-Z]{1,8}\b/;

/**
 * @param {string} summary  event title
 * @param {object} parsed   parseSummary(summary)
 * @param {{classes?:{key,name}[], rooms?:{key,name}[], teachers?:{key,name}[]|null}} index  school timetable entities
 * @returns {{score:number, issues:{code:string, text:string, penalty:number}[]}}
 */
export function assessSummary(summary, parsed, index = {}) {
  const issues = [];
  const add = (code, text, penalty) => issues.push({ code, text, penalty });
  const upper = summary.toUpperCase().replace(/\s+/g, ' ').trim();
  const segments = upper.split(/\s+-\s*|\s*-\s+/);
  const head = /^CLASS[EI]\s/.test(segments[0]);
  const classKeys = (index.classes || []).map((c) => c.key);

  // A class written without "CLASSE": the parser reads no class at all.
  if (!head && !parsed.classes.length && CLASS_TOKEN.test(upper.replace(/\([^)]*\)|\b(AULA|LAB\w*|SALA)\s+\S+/g, ''))) {
    add('class_no_prefix', 'Sembra nominare una classe ma non inizia con “CLASSE”/“CLASSI”', 50);
  }
  // Nothing else the timetable can use: an unrelated event (meeting, course).
  if (!parsed.classes.length && !parsed.room && !parsed.teachers.length && !parsed.absent.length) return finish(issues);

  // Classes
  if (head && !parsed.classes.length) add('class_unreadable', 'Dopo “CLASSE” non c’è un nome di classe valido', 45);
  for (const c of parsed.classes) {
    if (!classKeys.length) break;
    const matched = classKeys.filter((k) => sameClassKey(c, k));
    if (!matched.length) add('class_not_found', `Classe “${c}” non trovata nell’orario`, 45);
    else if (!matched.some((k) => k === c || k.startsWith(`${c}GRUPPO`))) {
      add('class_fuzzy', `Classe “${c}” associata per somiglianza a ${matched.join(', ')}`, 15);
    }
  }

  // Room
  if (parsed.room && index.rooms?.length) {
    const found = index.rooms.some((r) => sameRoom(parsed.room, r.name));
    if (!found && !KNOWN_PLACES.test(parsed.room.toUpperCase())) {
      add('room_not_found', `Aula “${parsed.room}” non trovata nell’orario`, 15);
    }
  }

  // Kind keyword with a typo
  if (kindHasTypo(upper)) add('kind_typo', `“${matchKind(upper).label}” scritto con un errore di battitura`, 10);

  // Separators
  if (/\S-\s|\s-\S/.test(upper.replace(/\b\d+-\d+\b/g, ''))) add('loose_dash', 'Trattino senza spazio da un lato', 5);

  // Segments we do not understand ("CLASSE 3A - AULA 46 - BLA BLA")
  let unknown = 0;
  for (const seg of segments.slice(1)) {
    const s = seg.replace(/\([^)]*\)/g, '').trim();
    if (!s || ROOM_RE.test(s) || /^PROF/.test(s) || matchKind(s) || /^(ORE|DALLE|ALLE)\b/.test(s)) continue;
    unknown += 1;
    if (unknown <= 2) add('unknown_part', `Parte non riconosciuta: “${s}”`, 15);
  }

  // Teachers
  if (/\bPROF/.test(upper) && !parsed.teachers.length && !parsed.absent.length) {
    add('prof_empty', 'C’è “PROF.” ma nessun nome leggibile', 10);
  }
  if (index.teachers?.length) {
    const words = (s) => s.toUpperCase().split(/\s+/).map(entityKey).filter(Boolean);
    const known = index.teachers.map((t) => words(t.name));
    const missing = [...parsed.teachers, ...parsed.absent].filter((n) => {
      const w = words(n);
      return !known.some((k) => w.every((x) => k.includes(x)));
    });
    missing.slice(0, 2).forEach((n) => add('teacher_not_found', `Docente “${n}” non trovato`, 10));
  }

  // A class with nothing that says what changes
  if (parsed.classes.length && parsed.kind === 'change' && !parsed.room && !parsed.teachers.length && !parsed.absent.length) {
    add('no_change', 'Nomina la classe ma non dice cosa cambia (aula, docente, uscita…)', 20);
  }

  return finish(issues);
}

function finish(issues) {
  const score = Math.max(0, 100 - issues.reduce((sum, i) => sum + i.penalty, 0));
  return { score, issues };
}
