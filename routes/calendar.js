import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { getUserEvents } from '../utils/events.js';

const router = express.Router();
const log = logger.child('calendar');

// Escape text per RFC 5545 (backslash, semicolon, comma, newlines).
function icsEscape(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold long content lines to <=75 octets (simplified: 73 chars + CRLF + space).
function fold(line) {
  if (line.length <= 73) return line;
  const parts = [];
  let s = line;
  parts.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length > 72) {
    parts.push(' ' + s.slice(0, 72));
    s = s.slice(72);
  }
  parts.push(' ' + s);
  return parts.join('\r\n');
}

// "2026-06-05T08:00:00+02:00" → "20260605T060000Z" (UTC). Date-only → "20260605".
function toIcsDateTime(dateTime) {
  const d = new Date(dateTime);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function toIcsDate(date) {
  return String(date).replace(/-/g, '');
}

function buildIcs(events) {
  const now = toIcsDateTime(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fermi Notify//Variazioni//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Fermi Notify — Variazioni',
    'X-WR-TIMEZONE:Europe/Rome',
  ];

  for (const e of events) {
    const summary = (e.similar ? '(probabile) ' : '') + (e.summary || 'Variazione');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscape(e.uid)}@fn.lkev.in`);
    lines.push(`DTSTAMP:${now}`);
    if (e.start.dateTime) {
      lines.push(fold(`DTSTART:${toIcsDateTime(e.start.dateTime)}`));
      if (e.end.dateTime) lines.push(fold(`DTEND:${toIcsDateTime(e.end.dateTime)}`));
    } else if (e.start.date) {
      lines.push(`DTSTART;VALUE=DATE:${toIcsDate(e.start.date)}`);
      if (e.end.date) lines.push(`DTEND;VALUE=DATE:${toIcsDate(e.end.date)}`);
    }
    lines.push(fold(`SUMMARY:${icsEscape(summary)}`));
    if (e.description) lines.push(fold(`DESCRIPTION:${icsEscape(e.description)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Public: calendar apps can't send a JWT, so the per-user ical_token authorizes.
// GET /user/calendar/:token.ics  (the .ics suffix is optional)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/:token', async (req, res) => {
  const token = String(req.params.token).replace(/\.ics$/i, '');
  if (!UUID_RE.test(token)) {
    return res.status(404).type('text/plain').send('Calendar not found');
  }
  try {
    const result = await pool.query(
      'SELECT id, tags, include_similar_tags FROM subscribers WHERE ical_token = $1',
      [token]
    );
    if (result.rowCount === 0) {
      return res.status(404).type('text/plain').send('Calendar not found');
    }
    const user = result.rows[0];
    const events = await getUserEvents(user);
    const ics = buildIcs(events);

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="ferminotify.ics"');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(ics);
  } catch (err) {
    log.error('Error building iCal feed', { error: err.stack || err });
    return res.status(500).type('text/plain').send('Internal error');
  }
});

export default router;
