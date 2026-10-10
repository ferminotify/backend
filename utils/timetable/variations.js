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
export function matchKind(upper) {
  const tokens = kindTokens(upper);
  return KINDS.find((k) => k.words.some((phrase) => hasPhrase(tokens, phrase)));
}

/** The kind was recognised only thanks to typo tolerance ("USCITA ANTICPATA"). */
export function kindHasTypo(upper) {
  const kind = matchKind(upper);
  if (!kind) return false;
  const joined = ` ${kindTokens(upper).join(' ')} `;
  return !kind.words.some((phrase) => joined.includes(` ${phrase.join(' ')} `));
}

export { ROOM_RE };

// "PROF.", "PROFF.", "PROF.ssa", "PROF.sse" (uppercased)
const PROF_PREFIX = /^PROFF?(?:\.?SS[AE])?\.?\s*/;

const ROOM_RE = /^(AULA|LAB(?:ORATORIO)?|PALESTRA|SALA|MENSA|BIBLIOTECA|AUDITORIUM)\b/;

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s'(.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .trim();

// Short words that are not acronyms ("ALUNNI DI IRC" → "alunni di IRC").
const SMALL_WORDS = new Set(['DI', 'DA', 'E', 'ED', 'IN', 'CON', 'PER', 'NON', 'DEL', 'DELLA', 'GLI', 'LE', 'I']);

/** "ALUNNI IRC" → "alunni IRC": lowercase, acronyms (up to 4 letters) kept. */
function groupLabel(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 4 && !SMALL_WORDS.has(w) ? w : w.toLowerCase()))
    .join(' ');
}

/**
 * Structured view of an event title. Events that do not name any class
 * (courses, meetings, counselling desk) still parse, with classes = [].
 */
export function parseSummary(summary) {
  const upper = summary.toUpperCase().replace(/\s+/g, ' ').trim();
  // " - " separates segments; also with a space on one side only ("CLASSE 3BMME- AULA 360").
  // A dash between letters/digits stays: "AULA 1-3 DEBATE".
  const segments = upper.split(/\s+-\s*|\s*-\s+/);

  let classes = [];
  let group = null;
  const head = segments[0].match(/^CLASS[EI]\s+(.+)$/);
  if (head) {
    // "(ALUNNI IRC)": only part of the class(es).
    const g = head[1].match(/\(([^)]*)\)/);
    if (g && !/ASSENT/.test(g[1])) group = groupLabel(g[1]);
    const list = head[1].replace(/\(.*?\)/g, ''); // drop "(ALUNNI IRC)"
    classes = list
      .split(',')
      .map((c) => entityKey(c))
      .filter((c) => /^[1-5][A-Z0-9]+$/.test(c));
  }

  const kindDef = matchKind(upper);

  let room = null;
  for (const seg of segments.slice(head ? 1 : 0)) {
    if (!ROOM_RE.test(seg)) continue;
    // "AULA 46 PROF. ESEMPIO" (missing dash) → keep only the place.
    room = seg.split(/\s+PROFF?\.?\s/)[0].replace(/\(.*?\)/g, '').trim();
    break;
  }

  // Absent teachers live inside parentheses: "(PROF.ssa DEL MODELLO: ASSENTE)", "(PROFF. A, B: ASSENTI)".
  const absent = [];
  for (const [, inner] of upper.matchAll(/\(([^)]*ASSENT[EI][^)]*)\)/g)) {
    const names = inner.replace(/:?\s*ASSENT[EI]/, '').replace(PROF_PREFIX, '');
    absent.push(...names.split(',').map((n) => titleCase(n.trim())).filter(Boolean));
  }

  // Present teachers: the "PROFF. A, B" / "PROF. A" segment, minus the parenthesised part.
  let teachers = [];
  const profMatch = upper.replace(/\([^)]*\)/g, '').match(/\bPROFF?(?:\.?SS[AE])?\.?\s+([^-]+)/);
  if (profMatch && !/^REF\b/.test(profMatch[0])) {
    teachers = profMatch[1]
      .split(',')
      .map((n) => titleCase(n.trim()))
      .filter((n) => n && !absent.includes(n));
  }

  return {
    classes,
    kind: kindDef?.kind || 'change',
    label: kindDef?.label || null,
    room: room ? titleCase(room) : null,
    roomNumber: room ? roomNumber(room) : null,
    group,
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
