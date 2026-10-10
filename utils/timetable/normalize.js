// Shared normalisation between the school timetable site and the calendar.
// The two sources spell entities differently ("3Ai in" vs "3AIIN", "Aula 46" vs "AULA 46"),
// so every lookup goes through a key made of uppercase letters and digits only.

/** "3Ai in" → "3AIIN", "1Qin gruppo 1" → "1QINGRUPPO1". */
export function entityKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Levenshtein distance, stopping early once it exceeds `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Does a class written by the calendar ("1QIN", "5EELEET") mean the school site's class
 * `classKey`? Exact; or a group of it ("1QIN" covers "1QINGRUPPO1"); or, for long
 * articulated names only, one letter off ("5EELEET" for "5EELEEET"), same year and section.
 * Short keys never match fuzzily: "3AIIN" and "3BIIN" are different classes.
 */
export function sameClassKey(eventKey, classKey) {
  if (eventKey === classKey || classKey.startsWith(`${eventKey}GRUPPO`)) return true;
  if (eventKey.length < 7 || classKey.length < 7 || classKey.includes('GRUPPO')) return false;
  if (eventKey.slice(0, 2) !== classKey.slice(0, 2)) return false;
  return editDistance(eventKey, classKey, 1) <= 1;
}

/**
 * Number that identifies a room, when it has one: "Aula 620 Disegno C" → "620",
 * "AULA 46" → "46", "Lab 610 Fisica 1" → "610". The calendar usually writes only
 * "AULA <n>", so this is the bridge between the two spellings.
 */
export function roomNumber(name) {
  const m = String(name || '').match(/\d+/);
  return m ? m[0] : null;
}

// Words that only say what kind of place a room is.
const ROOM_KIND_WORDS = new Set(['AULA', 'LAB', 'LABORATORIO', 'SALA', 'PALESTRA']);

/** Distinctive words of a room name: "Aula 1-3 Debate" → ["DEBATE"], "Sala mensa" → ["MENSA"]. */
function roomWords(name) {
  return String(name || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Z]+/)
    .filter((w) => w.length > 1 && !ROOM_KIND_WORDS.has(w));
}

/**
 * Does a room as written by the calendar ("AULA 46", "AULA DEBATE") name the room of the
 * school site ("Aula 46", "Aula 1-3 Debate")? By number when the calendar gives one,
 * else by the distinctive words, which must all appear in the site's name.
 */
export function sameRoom(calendarName, siteName) {
  const num = roomNumber(calendarName);
  if (num) return num === roomNumber(siteName);
  const words = roomWords(calendarName);
  if (!words.length) return entityKey(calendarName) === entityKey(siteName);
  const site = roomWords(siteName);
  return words.every((w) => site.includes(w));
}

/** "HH:MM" → minutes since midnight. */
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Minutes since midnight → "HH:MM". */
export function fromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
