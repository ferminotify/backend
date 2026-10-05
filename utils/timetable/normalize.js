// Shared normalisation between the school timetable site and the calendar.
// The two sources spell entities differently ("3Ai in" vs "3AIIN", "Aula 46" vs "AULA 46"),
// so every lookup goes through a key made of uppercase letters and digits only.

/** "3Ai in" → "3AIIN", "1Qin gruppo 1" → "1QINGRUPPO1". */
export function entityKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
