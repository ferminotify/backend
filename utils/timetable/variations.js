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

const KINDS = [
  // Order matters: "ALUNNI NON IN USCITA DIDATTICA - ENTRATA POSTICIPATA" is an entry, not a trip.
  { kind: 'entry', re: /ENTRATA\s+POSTICIPATA/, label: 'Entrata posticipata' },
  { kind: 'exit', re: /USCITA\s+ANTICIPATA/, label: 'Uscita anticipata' },
  { kind: 'trip', re: /USCITA\s+DIDATTICA/, label: 'Uscita didattica' },
  { kind: 'trip', re: /\bPCTO\b/, label: 'PCTO' },
  { kind: 'study', re: /STUDIO\s+AUTONOMO/, label: 'Studio autonomo' },
];

// "PROF.", "PROFF.", "PROF.ssa", "PROF.sse" (uppercased)
const PROF_PREFIX = /^PROF(?:F|\.?SS[AE])?\.?\s*/;

const ROOM_RE = /^(AULA|LAB(?:ORATORIO)?|PALESTRA|SALA|MENSA|BIBLIOTECA|AUDITORIUM)\b/;

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s'(.-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    .trim();

/**
 * Structured view of an event title. Events that do not name any class
 * (courses, meetings, counselling desk) still parse, with classes = [].
 */
export function parseSummary(summary) {
  const upper = summary.toUpperCase().replace(/\s+/g, ' ').trim();
  const segments = upper.split(/\s+-\s+/);

  let classes = [];
  const head = segments[0].match(/^CLASS[EI]\s+(.+)$/);
  if (head) {
    const list = head[1].replace(/\(.*?\)/g, ''); // drop "(ALUNNI IRC)"
    classes = list
      .split(',')
      .map((c) => entityKey(c))
      .filter((c) => /^[1-5][A-Z0-9]+$/.test(c));
  }

  const kindDef = KINDS.find((k) => k.re.test(upper));

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
  const profMatch = upper.replace(/\([^)]*\)/g, '').match(/\bPROF(?:F|\.?SS[AE])?\.?\s+([^-]+)/);
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
    teachers,
    absent,
  };
}

/** All variations currently published, cached briefly. Each event gets its parsed fields merged in. */
export async function getVariations() {
  const { value, stale } = await eventsCache.get('events', async () => {
    const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Events CSV ${res.status}`);
    const events = parseEventsCsv(await res.text());
    log.debug('Fetched variations', { count: events.length });
    return events.map((e) => ({ ...e, ...parseSummary(e.summary) }));
  });
  if (stale) log.warn('Serving stale variations');
  return { variations: value, stale };
}
