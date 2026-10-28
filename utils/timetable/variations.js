// Timetable variations from the school calendar (via the public Google Sheet the
// Apps Script keeps in sync, same source as the frontend's "Cerca eventi").
// Each event title is free text such as:
//   "CLASSE 3AIIN - AULA 46 - PROFF. ESEMPIO, PROVA (PROF.ssa DEL MODELLO: ASSENTE)"
//   "CLASSE 4EAU - USCITA ANTICIPATA"
//   "CLASSI 5C, 5D, 5E - USCITA DIDATTICA - PROFF. ..."
// and is turned into a structured variation the merge step can apply to a timetable.
import logger from '../logger.js';
import { createCache } from './cache.js';
import { entityKey, roomNumber } from './normalize.js';
import { calendarEnabled, getCalendarEvents } from './calendar.js';

const log = logger.child('timetable:variations');

const CSV_URL =
  process.env.EVENTS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/1ADaUVRQeYU078-suUxGk0u1aMj_GbcjsAzG11YlMp5g/export?format=csv&gid=0';
const TTL_MS = Number(process.env.EVENTS_TTL_MS) || 2 * 60 * 1000;

const eventsCache = createCache({ ttlMs: TTL_MS, maxEntries: 1 });

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text → events: { uid, summary, date, start, end, allDay } with local "HH:MM" times. */
export function parseEventsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const col = (r, name) => r[header.indexOf(name)] || '';
  return rows
    .slice(1)
    .map((r) => {
      const startDT = col(r, 'start.dateTime');
      const endDT = col(r, 'end.dateTime');
      // dateTime strings carry the school's local offset ("2026-10-05T10:00:00+02:00"),
      // so date and wall-clock time are read straight from the string.
      const allDay = !startDT;
      return {
        uid: col(r, 'uid'),
        summary: col(r, 'summary').trim(),
        date: allDay ? col(r, 'start.date') : startDT.slice(0, 10),
        start: allDay ? null : startDT.slice(11, 16),
        end: allDay ? null : endDT.slice(11, 16) || startDT.slice(11, 16),
        allDay,
      };
    })
    .filter((e) => e.uid && e.summary && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
}

// Each kind lists word sequences; a title matches when the words appear consecutively,
// each within a small edit distance (see fuzzyEqual), so typos like "USCITA ANTICPATA"
// or "ENTRATE POSTICIPATE" still count. Short words ("PCTO") must match exactly.
const KINDS = [
  // Order matters: "ALUNNI NON IN USCITA DIDATTICA - ENTRATA POSTICIPATA" is an entry, not a trip.
  { kind: 'entry', words: [['ENTRATA', 'POSTICIPATA'], ['INGRESSO', 'POSTICIPATO']], label: 'Entrata posticipata' },
  { kind: 'exit', words: [['USCITA', 'ANTICIPATA']], label: 'Uscita anticipata' },
  { kind: 'trip', words: [['USCITA', 'DIDATTICA']], label: 'Uscita didattica' },
  // "VIAGGIO D'ISTRUZIONE" / "DI ISTRUZIONE": "D"/"DI" are dropped as filler before matching.
  { kind: 'trip', words: [['VIAGGIO', 'ISTRUZIONE']], label: 'Viaggio d’istruzione' },
  { kind: 'trip', words: [['PCTO']], label: 'PCTO' },
  { kind: 'trip', words: [['VISITA', 'AZIENDALE'], ['VISITA', 'GUIDATA'], ['VISITA', 'FIERA'], ['VISITA', 'DIDATTICA']], label: 'Uscita didattica' },
  { kind: 'study', words: [['STUDIO', 'AUTONOMO']], label: 'Studio autonomo' },
];

const FILLER = new Set(['D', 'DI']);

/** Levenshtein distance, capped: returns max+1 as soon as it is exceeded. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typo tolerance by word length: exact up to 4 letters, 1 edit up to 7, else 2. */
function fuzzyEqual(word, target) {
  const max = target.length <= 4 ? 0 : target.length <= 7 ? 1 : 2;
  return editDistance(word, target, max) <= max;
}

function hasPhrase(tokens, phrase) {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, k) => fuzzyEqual(tokens[i + k], w))) return true;
  }
  return false;
}

const kindTokens = (upper) =>
  upper
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !FILLER.has(t));

/** First kind whose words appear in the title, or undefined. */
// "LEZIONE DAD DI FISICA SOSPESA", "SOSPENSIONE DELLE LEZIONI": no lesson at all.
const SUSPENDED = /\bLEZION\w*\b.*\bSOSPES[AOIE]\b|\bSOSPENSION\w*\b.*\bLEZION/;
const SUSPENDED_KIND = { kind: 'off', label: 'Lezione sospesa' };

export function matchKind(upper) {
  if (SUSPENDED.test(upper)) return SUSPENDED_KIND;
  const tokens = kindTokens(upper);
  return KINDS.find((k) => k.words.some((phrase) => hasPhrase(tokens, phrase)));
}

/** The kind was recognised only thanks to typo tolerance ("USCITA ANTICPATA"). */
export function kindHasTypo(upper) {
  const kind = matchKind(upper);
  if (!kind?.words) return false;
  const joined = ` ${kindTokens(upper).join(' ')} `;
  return !kind.words.some((phrase) => joined.includes(` ${phrase.join(' ')} `));
}

export { ROOM_RE, PROF_START, GROUP_SEGMENT, INITIAL_NAME };

const ROOM_RE = /^(AULA|AULE|LAB(?:ORATORIO)?|FABLAB|PALESTRA|SALA|SALONE|MENSA|BIBLIOTECA|AUDITORIUM|CORTILE|LOCALE|AREA|SEGGIO|DI ?FRONTE|DAVANTI)\b/;

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s'(.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .trim();

// Short words that are not acronyms ("ALUNNI DI IRC" → "alunni di IRC").
const SMALL_WORDS = new Set(['DI', 'DA', 'E', 'ED', 'IN', 'CON', 'PER', 'NON', 'DEL', 'DELLA', 'DELLE', 'GLI', 'LE', 'I', 'AL', 'ALLA']);
// Longer acronyms kept uppercase in labels.
const ACRONYMS = new Set(['INVALSI', 'CLIL', 'PCTO', 'AVIS', 'ADMO', 'AIDO', 'DAD', 'IRC', 'ITS', 'CAD', 'ECDL', 'FCE', 'PET']);

/** "ALUNNI IRC" → "alunni IRC": lowercase, acronyms (up to 4 letters, or known) kept. */
function groupLabel(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w) || (w.length <= 4 && /[A-Z]/.test(w) && !SMALL_WORDS.has(w)) ? w : w.toLowerCase()))
    .join(' ');
}

/** "PROVA RECUPERO STORIA" → "Prova recupero storia" (acronyms kept). */
function sentenceLabel(text) {
  const words = text.trim().split(/\s+/).map((w) => (ACRONYMS.has(w.replace(/[^A-Z]/g, '')) || /\d/.test(w) ? w : w.toLowerCase()));
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// A segment naming the classes: "CLASSE 3A", "CLASSI 5C, 5D", with an optional group of
// students first: "ALUNNO B. F. CLASSE 3CIIN", "ALUNNI IRC DELLE CLASSI 2BIN, 1B".
// Other words before CLASSE ("CONSIGLIO DI CLASSE 5B") are a meeting, not the class.
const CLASS_SEGMENT = /^(?:((?:ALUNN[OIAE]|STUDENT[EI]|STUDENTESS[AE])\b.*?)\s+(?:DELL[AE]\s+)?)?CLASS[EI]\s*:?\s+(.+)$/;
const CANCELLED = /^ANNULLAT[AOIE]\b\s*/;
// "SPORTELLO MATEMATICA - PROF. ROSSI ANNULLATO"
const CANCELLED_END = /\s+ANNULLAT[AOIE]$/;
/**
 * " - " separates segments; also with a space on one side only ("CLASSE 3BMME- AULA 360").
 * A dash between letters/digits stays ("AULA 1-3 DEBATE"), and so does one inside parentheses
 * ("(ALUNNI ATTIVITÀ DIDATTICHE - NO IRC)"). Stray dashes ("- -AULA 509") are dropped.
 */
export function splitSegments(upper) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < upper.length; i++) {
    const c = upper[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === '-' && !depth && (upper[i - 1] === ' ' || upper[i + 1] === ' ' || i === 0)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.replace(/^[\s-]+|[\s-]+$/g, '').trim()).filter(Boolean);
}

// Words before CLASSE that make it a meeting about the class, not the class itself.
// --- whole years: "CLASSI 1^ LICEO", "CLASSI 3^-4^ IT", "CLASSI QUARTE", "TRIENNIO" ---------
const ORDINALS = { PRIME: '1', SECONDE: '2', TERZE: '3', QUARTE: '4', QUINTE: '5' };
const SPANS = { BIENNIO: ['1', '2'], TRIENNIO: ['3', '4', '5'] };
// Liceo classes have no course in the name ("1A", "3B"); technical ones do ("1CIN", "2AME");
// evening ones have section S ("3SIIN", "4SMME").
const TRACKS = [
  [/^(LICEO|LICEALI|LSSA|LS)$/, 'liceo'],
  [/^(IT|ITIS|ITI|TECNICO|TECNICHE|TECNICI|IST\.?)$/, 'it'],
  [/^SERAL[EI]$/, 'serale'],
];
// Course words → letters in the class key after year and section ("MECCANICA" → 3AME, 3SMME).
const COURSES = [
  [/^MECCANIC|^MECCATRONIC/, 'ME'],
  [/^INFORMATIC/, 'IN'],
  [/^ELETTRONIC|^ELETTROTECNIC/, 'E'],
  [/^CHIMIC/, 'CH'],
  // BIO = Biotecnologie ambientali (3Abio, 5C bio), where Biologia/microbiologia is taught
  [/^BIOTECNOLOG|^BIOLOG/, 'BIO'],
];
const FILLER_WORDS = new Set(['TUTTE', 'LE', 'CORSO', 'INDIRIZZO', 'DI', 'DEL', 'DELLE']);

/**
 * Years named instead of classes, or null when the text is not of that kind.
 * @returns {null | {year: string, track: 'liceo'|'it'|'serale'|'other'|null, course: string|null}[]}
 *   track null = any; 'other' = words we cannot place (not applied)
 */
export function parseLevels(text) {
  const words = text.replace(/\([^)]*\)/g, ' ').replace(/(\d)\s*\^/g, '$1^ ').split(/[\s,\-/]+|\bE\b/).filter(Boolean);
  const years = [];
  let track = null;
  let course = null;
  let unknown = false;
  for (const w of words) {
    if (/^[1-5]\^$/.test(w)) years.push(w[0]);
    else if (ORDINALS[w]) years.push(ORDINALS[w]);
    else if (SPANS[w]) years.push(...SPANS[w]);
    else if (FILLER_WORDS.has(w)) continue;
    else {
      const t = TRACKS.find(([re]) => re.test(w))?.[1];
      const c = COURSES.find(([re]) => re.test(w))?.[1];
      if (t) track = track && track !== t ? null : t; // "LICEO E IT": both
      else if (c) course = c;
      else unknown = true;
    }
  }
  if (!years.length) return null;
  if (unknown) track = 'other';
  return [...new Set(years)].sort().map((year) => ({ year, track, course }));
}

/** Track of a school-site class key: "1A" → liceo; "3SIIN" → serale; "1CIN", "4EELEE" → it. */
export function classTrack(classKey) {
  const k = classKey.replace(/GRUPPO.*$/, '');
  if (/^[1-5][A-Z]$/.test(k)) return 'liceo';
  return /^[1-5]S[A-Z]{2,}/.test(k) ? 'serale' : 'it';
}

/** Does a whole-years level ({year, track, course}) cover the class? */
export function levelCovers(level, classKey) {
  if (classKey[0] !== level.year) return false;
  if (level.track === 'other') return false;
  // A course implies a technical class (day or evening), never liceo.
  const track = classTrack(classKey);
  if (level.track ? level.track !== track : level.course && track === 'liceo') return false;
  return !level.course || classKey.replace(/GRUPPO.*$/, '').slice(2).includes(level.course);
}

const MEETING_BEFORE_CLASS = /\b(CONSIGLI|RIUNION|COORDINATOR|GENITORI|ASSEMBLEA|COLLOQU)\w*\b.*$|\b(DI|DELLA|DEI)$/;
// A teacher's title: "PROF. ", "PROFF.", "PROF.ssa ", "PROF. ssa", "PROF.D'ECCLESIIS" (no space
// after the dot), "PROF" alone ("PROF- ROSSI"), typos ("PROPF.", "PRF.", "PTOF.", "PRORF."), "ING.", "SIG .", "DOTT.",
// optionally after "REF.", "REFERENTE", "COORDINATORE", "MIT" ("MIT DOTT. JAVED").
// "REF." alone also names the person in charge ("REF. ROSSI").
const TITLE = /(?:P[RT]O?R?P?FF?(?:\.?\s?SS[AE])?|PRO(?=\.)|PORF|ING|SIG(?:R[AI])?|DOTT(?:\.?SS[AE])?)(?:\s*[.,]\s*|\s+|$)/;
const LEAD = /(?:REFF?(?:ERENTE)?|COORDINATOR[EI]|MIT)(?:\s*\.\s*|\s+)/;
const PROF_START = new RegExp(`^(?:${LEAD.source})*(?:${TITLE.source})|^REF(?:ERENTE)?(?:\\s*\\.\\s*|\\s+)`);
const TITLE_AT_START = new RegExp(`^${TITLE.source}`);
// "E. CIRANNA", "M. BERTOGNA": an initial and a surname, a speaker named without a title.
const INITIAL_NAME = /(?:^|,\s*)([A-Z]\.\s?[A-Z'’]{2,}(?:\s[A-Z'’]{2,})?)$/;
// "PRIMO GRUPPO", "SECONDO GRUPPO GRUPPO" (typo): part of the classes.
const GROUP_SEGMENT = /^(PRIMO|SECONDO|TERZO|QUARTO)\s+GRUPPO\b/;
// Parentheses that are details, not part of the activity's name.
const DROP_PAREN = /AS+ENT|PROF|REF|ALUNN|STUDENT|\bNON\b|\bORE\b|FINO|DALLE|ALLE\b|VEDI|ANTICIP|POSTICIP/;

/** A segment that is only a surname or two ("DELLA ROCCA", "FERRARI S."). */
function looksLikeName(seg) {
  const s = seg.replace(/\([^)]*\)/g, '').trim();
  return /^[A-Z'’. ]+$/.test(s) && s.split(/\s+/).length <= 3 && !ROOM_RE.test(s) && !matchKind(s) && !/^(TUTOR|SIG|DOTT|CLASS)/.test(s);
}

/**
 * Structured view of an event title. Events that do not name any class
 * (courses, meetings, counselling desk) still parse, with classes = [].
 *
 * `activity`: what the class does, when the title says it in its own words
 * ("PROVA RECUPERO STORIA", "PEER TUTORING MATEMATICA"); null otherwise.
 * `cancelled`: the title starts with "ANNULLATA": the variation no longer applies.
 */
export function parseSummary(summary) {
  let upper = summary.toUpperCase().replace(/\s+/g, ' ').trim();
  const cancelled = CANCELLED.test(upper);
  if (cancelled) upper = upper.replace(CANCELLED, '').replace(/^-\s*/, '');
  // "CLASE 4CIIN", "CLSSE 4EELE", "CLASS 1CME", "CLADDE 5EELE": "CLASSE" with a typo, before a class.
  upper = upper.replace(/\bCL[A-Z]{2,5}(?=\s*:?\s*[1-5])/g, (w) =>
    w === 'CLASSE' || w === 'CLASSI' || Math.min(editDistance(w, 'CLASSE', 2), editDistance(w, 'CLASSI', 2)) > 2 ? w : 'CLASSE'
  );
  // "AULA 4CCH - AULA 29": a class written where "CLASSE" should be.
  upper = upper.replace(/\bAULA\s+(?=[1-5][A-Z]{2,}\b)/g, 'CLASSE ');
  const cancelledEnd = CANCELLED_END.test(upper);
  if (cancelledEnd) upper = upper.replace(CANCELLED_END, '');
  // " - " separates segments; also with a space on one side only ("CLASSE 3BMME- AULA 360").
  // A dash between letters/digits stays: "AULA 1-3 DEBATE".
  const segments = splitSegments(upper)
    // A class named inside another segment ("PEER TUTORING MATEMATICA CLASSE 3MENE") gets its
    // own. A meeting keeps its name: "CONSIGLIO DI CLASSE 1CIN" → "CONSIGLIO DI CLASSE", "CLASSE 1CIN".
    .flatMap((seg) => {
      const m = seg.match(/^(.+?)\s+(?:PER\s+LE\s+)?((?:ALUNN\w*\b.*?\s+)?CLASS[EI]\s*:?\s+[1-5].*)$/);
      if (!m || CLASS_SEGMENT.test(seg) || /^TUTOR\b/.test(m[1])) return [seg];
      // "REF. ALUNNO ROSSI CLASSE 2AEL": the student is the one in charge, not a group.
      if (/^REF(?:ERENTE)?\b\.?$/.test(m[1])) {
        const at = seg.search(/\s+CLASS[EI]\b/);
        return [seg.slice(0, at), seg.slice(at).trim()];
      }
      if (MEETING_BEFORE_CLASS.test(m[1])) {
        const [, word] = m[2].match(/^(CLASS[EI])/) || [];
        return [/\b(DI|DELLA|DEI)$/.test(m[1]) && word ? `${m[1]} ${word}` : m[1], m[2]];
      }
      return [m[1], m[2]];
    })
    // "AULA 380 PROFF. ROSSI, VERDI", "CORSO STEM 10H, PROF. PAOLO ROSSI": the teachers, missing a dash.
    .flatMap((seg) => {
      const at = seg.search(/(?:,\s*|\s+)(?=(?:REF\.?\s*)?P[RT]O?R?P?FF?(?:\.|\s+SS|SS|\s))/);
      if (at <= 0 || (seg[at] !== ',' && !ROOM_RE.test(seg) && !CLASS_SEGMENT.test(seg))) return [seg];
      return [seg.slice(0, at).trim(), seg.slice(at).replace(/^,?\s*/, '')];
    });
  const named = segments.length; // segments written in the title (more are pushed below)
  const used = new Set(); // segments read as classes or teachers

  let classes = [];
  let levels = [];
  let group = null;
  // "TUTTE LE CLASSI": every class, all years.
  const allAt = segments.findIndex((seg) => /^TUTTE LE CLASSI\b/.test(seg));
  if (allAt >= 0) {
    const named = parseLevels(segments[allAt].replace(/^TUTTE LE CLASSI\s*/, ''));
    levels = named || ['1', '2', '3', '4', '5'].map((year) => ({ year, track: null }));
    used.add(allAt);
  }
  const classAt = segments.findIndex((seg) => CLASS_SEGMENT.test(seg));
  if (classAt >= 0) {
    used.add(classAt);
    const [, who, rest] = segments[classAt].match(CLASS_SEGMENT);
    if (who) group = groupLabel(who);
    // "(ALUNNI IRC)": only part of the class(es).
    const g = rest.match(/\(([^)]*)\)/);
    if (g && !/AS+ENT/.test(g[1]) && !group) group = groupLabel(g[1]);
    // "3EAU AULA 509" (missing dash): the room is read from the segments below.
    const [list, place] = rest
      .replace(/\(.*?\)/g, '') // drop "(ALUNNI IRC)"
      .replace(/\bA\.?\s?S\.?\s*\d{2,4}\s*[/-]\s*\d{2,4}/g, '') // "A.S. 2025/2026", "A.S. 24-25"
      .split(/\s+(?=(?:AUL[AE]|LAB\w*|PALESTRA|SALA|MENSA|PROFF?\b))/);
    if (place) segments.push(place);
    // "CLASSI 1^ LICEO", "CLASSI 3^-4^ IT", "CLASSI QUARTE": whole years, not classes.
    // Students named after them ("TRIENNIO LICEO ALUNNI NON PARTECIPANTI") are the group.
    const [yearsText, students] = list.split(/\s+(?=ALUNN)/);
    const named = parseLevels(yearsText);
    if (named) {
      levels = named;
      if (students) group = groupLabel(students);
      // "CLASSI 1^ - 2^ LICEO": the years go on in the next segment.
      const more = segments[classAt + 1] && parseLevels(segments[classAt + 1]);
      if (more && /^\d\^/.test(segments[classAt + 1])) {
        used.add(classAt + 1);
        const track = more[0].track;
        levels = [...new Set([...levels.map((l) => l.year), ...more.map((l) => l.year)])].sort().map((year) => ({ year, track }));
      }
    } else {
      classes = list
        .split(/,|\+|\/|-|\s+E\s+|\s+(?=[1-5][A-Z])/)
        .map((piece) => {
          // "4BIIN GIORNATA DELLE UNIVERSITÀ" (missing dash): a class name goes on only with
          // short words ("3EELE EAU"); the rest is read as another segment.
          const [first, ...words] = piece.trim().split(/\s+/);
          const cut = words.findIndex((w) => !/^[A-Z]{1,4}$/.test(w));
          // "ALUNNO CLASSE 4EELE RIENTRATO DALL'ANNO ALL'ESTERO": the words describe the student.
          if (cut >= 0 && who) group = groupLabel(`${who} ${words.slice(cut).join(' ')}`);
          else if (cut >= 0) segments.push(words.slice(cut).join(' '));
          return entityKey([first, ...(cut >= 0 ? words.slice(0, cut) : words)].join(''));
        })
        .filter((c) => /^[1-5][A-Z0-9]+$/.test(c));
    }
    // "CLASSI 5A - 5B - SALA EROS": more classes in the next segments.
    for (let i = classAt + 1; i < segments.length && /^[1-5][A-Z]{1,8}( ?[A-Z]{1,4})?$/.test(segments[i]); i++) {
      classes.push(entityKey(segments[i]));
      used.add(i);
    }
  }

  // "(ALUNNI NON IN VIAGGIO D'ISTRUZIONE)": those staying, not a trip.
  const kindDef = matchKind(upper.replace(/\([^)]*\bNON\b[^)]*\)/g, ''));

  // Absent teachers live inside parentheses: "(PROF.ssa DEL MODELLO: ASSENTE)", "(PROFF. A, B: ASSENTI)".
  const absent = [];
  for (const [, inner] of upper.matchAll(/\(([^)]*AS+ENT[EI][^)]*)\)/g)) {
    const names = inner.replace(/:?\s*AS+ENT[EI]/, '').trim().replace(PROF_START, '');
    // "(PROFF. ARENA E DESINA: ASSENTI)", "(PROF. ssa ROSSI ASSENTE)"
    absent.push(...names.split(/,|\s+E\s+/).map((n) => titleCase(n.trim().replace(TITLE_AT_START, ''))).filter(Boolean));
  }

  // Present teachers: every segment starting with a title ("PROFF. A, B", "ING. VERDI",
  // "MIT DOTT. BIANCHI"), minus the parenthesised part, plus titled names inside parentheses
  // ("(PROFF. A, B)", "(Referente prof Rossi)"). After "PROFF" or a bare "PROF" ("PROF- ROSSI"),
  // names may go on in the next segments: "PROFF. A - B".
  let teachers = [];
  const noParens = (x) => x.replace(/\([^)]*\)/g, '').trim();
  const addNames = (text) =>
    teachers.push(
      ...text
        .split(/,|\s*-\s*|\s+E\s+|\s*\+\s*|(?<=[A-Z]{3})\.\s+/)
        .filter((n) => !/^\s*(STUDENT|TECNIC)/.test(n))
        .map((n) => n.trim().replace(PROF_START, '').replace(TITLE_AT_START, ''))
        .map((n) => titleCase(n.replace(/\s+[1-5][A-Z]{1,8}$/, '').trim()))
    );
  segments.forEach((seg, i) => {
    if (used.has(i) || !PROF_START.test(noParens(seg))) return;
    used.add(i);
    const head = noParens(seg);
    const names = [head.replace(PROF_START, '')];
    if (/^PROFF|^PROF$/.test(head.replace(new RegExp(`^(?:${LEAD.source})+`), ''))) {
      for (let j = i + 1; j < named && !used.has(j) && looksLikeName(segments[j]); j++) {
        names.push(noParens(segments[j]));
        used.add(j);
      }
    }
    names.forEach(addNames);
  });
  for (const [, inner] of upper.matchAll(/\(([^)]*)\)/g)) {
    if (!/AS+ENT/.test(inner) && PROF_START.test(inner.trim())) addNames(inner.trim().replace(PROF_START, ''));
  }
  // "… - E. CIRANNA", "\"DRONI, ROBOT\", M. BERTOGNA": a speaker without a title, at the end.
  segments.forEach((seg, i) => {
    if (used.has(i) || i >= named) return;
    const m = noParens(seg).match(INITIAL_NAME);
    if (!m) return;
    teachers.push(titleCase(m[1]));
    const rest = noParens(seg).slice(0, m.index).replace(/[,\s]+$/, '');
    if (rest) segments[i] = rest;
    else used.add(i);
  });
  // Peer tutoring without "TUTOR": "PEER TUTORING INGLESE - GOLA 5IIN" (the tutor and their class).
  if (/\bTUTORING\b/.test(upper)) {
    segments.forEach((seg, i) => {
      if (used.has(i) || i >= named || !/^[A-Z'’]{3,}(?:\s[A-Z'’]{2,})?\s+[1-5][A-Z]{1,8}$/.test(noParens(seg))) return;
      if (ROOM_RE.test(seg) || CLASS_SEGMENT.test(seg) || /^TUTOR\b/.test(seg)) return;
      used.add(i);
      addNames(noParens(seg));
    });
  }
  // Peer tutoring: "TUTOR SACCANI 5CBIO", "TUTOR: MARAGNI (3BIIN)". The tutor counts as the
  // teacher; their own class is not one of the classes involved, unless no other is named.
  let tutorClass = null;
  segments.forEach((seg, i) => {
    const m = noParens(seg).match(/^TUTOR\s*:?\s*(.+)$/);
    if (!m) return;
    used.add(i);
    tutorClass ||= m[1].match(/\bCLASS[EI]\s+([1-5][A-Z]{1,8})\b/)?.[1] || null;
    const name = m[1].replace(/\bCLASS[EI]\b.*$/, '').replace(/\s+[1-5][A-Z]{1,8}\b.*$/, '').trim();
    if (name) teachers.push(titleCase(name));
  });
  if (!classes.length && !levels.length) {
    // "PEER TUTORING INFORMATICA 1CIN - TUTOR ROSSI CLASSE 3IIN": the class at the end of a segment.
    segments.forEach((seg, i) => {
      const m = !classes.length && !used.has(i) && seg.match(/^(.+)\s([1-5][A-Z]{2,8})$/);
      if (!m || ROOM_RE.test(seg) || !/\bTUTORING\b/.test(m[1])) return;
      classes.push(m[2]);
      segments[i] = m[1];
    });
    if (!classes.length && tutorClass) classes.push(tutorClass);
  }

  // "COLLABORATORE SCOLASTICO": school staff watching the class, shown as its teacher.
  segments.forEach((seg, i) => {
    if (used.has(i) || !/^COLLABORATOR\w*\s+SCOLASTIC\w*$/.test(noParens(seg))) return;
    used.add(i);
    teachers.push('Collaboratore scolastico');
  });

  teachers = [...new Set(teachers.filter((n) => n && !absent.includes(n)))];

  let room = null;
  const activities = [];
  // "(ANTICIPA 6^ ORA)": the class starts or ends earlier.
  for (const [, inner] of upper.matchAll(/\(([^)]*)\)/g)) {
    if (/^(ANTICIP|POSTICIP)/.test(inner.trim())) activities.push(inner.trim());
  }
  segments.forEach((seg, i) => {
    if (used.has(i)) return;
    const clean = noParens(seg);
    if (!clean) return;
    // "PRIMO GRUPPO": part of the classes.
    if (GROUP_SEGMENT.test(clean)) {
      if (!group) group = groupLabel(clean.match(/^\w+\s+GRUPPO/)[0]);
      return;
    }
    // "CLASSE 2ACH - ALUNNO S. B. G. - PROVA STORIA": the students, in a segment of their own.
    if (!group && /^(ALUNN[OIAE]|STUDENT\w*)\b/.test(clean) && clean.split(/\s+/).length <= 6) {
      group = groupLabel(clean);
      return;
    }
    if (ROOM_RE.test(clean)) {
      // "AULA 46 PROF. ESEMPIO" (missing dash) → keep only the place.
      // Parentheses stay: "AULA MAGNA (CON TECNICO)".
      if (!room) room = seg.replace(/\(([^)]*AS+ENT[^)]*)\)/g, '').split(/\s+PROFF?\.?\s/)[0].trim();
      return;
    }
    if (CLASS_SEGMENT.test(clean)) return; // the classes named again
    if (/^(PROF|REF\b|SIG\w*\b|DOTT\w*\b|ORE\b|DALLE\b|ALLE\b)/.test(clean)) return;
    // The kind's own words are the badge; a visit keeps its details ("VISITA AZIENDALE PIUSI").
    const k = matchKind(clean);
    if (k && k.kind !== 'off' && !(k.label === 'Uscita didattica' && /^VISITA\b/.test(clean))) return;
    // Parentheses that name something stay: "VISIONE PROVE SC. INTEGRATE (CHIMICA)".
    activities.push(seg.replace(/\s*\(([^)]*)\)/g, (all, inner) => (DROP_PAREN.test(inner) ? '' : all)).trim());
  });

  return {
    classes,
    kind: kindDef?.kind || 'change',
    label: kindDef?.label || null,
    room: room ? titleCase(room) : null,
    roomNumber: room ? roomNumber(noParens(room)) : null,
    // "CORSO SERALE - CLASSI TERZE MECCANICA": the evening school.
    levels: /\bSERAL[EI]\b/.test(upper) ? levels.map((l) => (l.track === null ? { ...l, track: 'serale' } : l)) : levels,
    group,
    activity: activities.length ? sentenceLabel(activities.join(' - ')) : null,
    cancelled: cancelled || cancelledEnd,
    teachers,
    absent,
  };
}

const schoolToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

async function loadCsv() {
  const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Events CSV ${res.status}`);
  return { events: parseEventsCsv(await res.text()), window: null, source: 'csv' };
}

/**
 * All variations currently published, cached briefly. Each event gets its parsed fields merged in.
 * Source: the Calendar API when configured (see calendar.js), else the Sheet CSV; the CSV is
 * also the fallback when the API fails. `window` is the date range the source covers
 * ({from, to}), or null for the CSV (its range is set by the Apps Script).
 */
export async function getVariations() {
  const { value, stale } = await eventsCache.get('events', async () => {
    let loaded;
    if (calendarEnabled()) {
      try {
        const { events, from, to } = await getCalendarEvents(schoolToday());
        loaded = { events, window: { from, to }, source: 'calendar' };
      } catch (err) {
        log.warn('Calendar API failed, using the CSV', { error: err.message });
      }
    }
    loaded ||= await loadCsv();
    log.debug('Fetched variations', { count: loaded.events.length, source: loaded.source });
    const variations = loaded.events.map((e) => ({ ...e, ...parseSummary(e.summary) }));
    return { variations, window: loaded.window, source: loaded.source };
  });
  if (stale) log.warn('Serving stale variations');
  return { ...value, stale };
}
