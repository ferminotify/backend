// Italian formats, Rome time.
export const TZ = 'Europe/Rome';

const NUM = new Intl.NumberFormat('it-IT', { useGrouping: 'always' }); // Italian skips the dot in 4 digits
export const num = (n) => NUM.format(Number(n) || 0);
export const pct = (x, digits = 0) =>
  x == null || !Number.isFinite(x) ? '–' : new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: digits }).format(x);

/** 'YYYY-MM-DD' → "3 nov" / "lun 3". */
const day = (iso, opts) => new Intl.DateTimeFormat('it-IT', { ...opts, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
export const dayMonth = (iso) => day(iso, { day: 'numeric', month: 'short' });
export const weekday = (iso) => day(iso, { weekday: 'short', day: 'numeric' });

const sameYear = (d) => d.getFullYear() === new Date().getFullYear();
export const dateTime = (d) => new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', ...(sameYear(d) ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', timeZone: TZ,
}).format(d);
export const date = (d) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }).format(d);

const REL = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
export function ago(d) {
  const min = Math.round((d.getTime() - Date.now()) / 60000);
  if (Math.abs(min) < 60) return REL.format(min, 'minute');
  if (Math.abs(min) < 48 * 60) return REL.format(Math.round(min / 60), 'hour');
  return REL.format(Math.round(min / 1440), 'day');
}

export function readAt(now = new Date()) {
  const f = (opts) => new Intl.DateTimeFormat('it-IT', { ...opts, timeZone: TZ }).format(now);
  return `Dati letti alle ${f({ hour: '2-digit', minute: '2-digit' })} del ${f({ day: 'numeric', month: 'long' })}.`;
}
