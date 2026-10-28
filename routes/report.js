// "Segnala un problema": anonymous reports about the timetable page, emailed to the admins.
// Mounted before the global JSON parser: the optional screenshot needs a larger body limit.
import express from 'express';
import { clientIp, reportLimited } from '../utils/limiter.js';
import logger from '../utils/logger.js';
import { REPORT_EMAIL, sendReportMail } from '../utils/reportMail.js';

const router = express.Router();
const log = logger.child('report');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
router.use(express.json({ limit: '6mb' }));


const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Trimmed string up to `max` chars, or '' for anything else. */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Context fields sent by the page, in display order.
const CONTEXT_FIELDS = [
  ['entity', 'Classe / aula / docente', 120],
  ['date', 'Giorno', 40],
  ['time', 'Ora', 60],
  ['subject', 'Materia', 160],
  ['detail', 'Aula / classe', 200],
  ['teachers', 'Docenti', 300],
  ['status', 'Stato', 40],
  ['variations', 'Variazioni', 2000],
  ['url', 'Pagina', 500],
];

/** Decodes the optional screenshot; only real PNG/JPEG/WebP files, by their first bytes. */
function decodeImage(img) {
  if (!img || typeof img.data !== 'string') return null;
  const buf = Buffer.from(img.data, 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new RangeError('image size');
  const type =
    buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG'
      ? ['image/png', 'png']
      : buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
        ? ['image/jpeg', 'jpg']
        : buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
          ? ['image/webp', 'webp']
          : null;
  if (!type) throw new TypeError('image type');
  return { filename: `screenshot.${type[1]}`, content: buf, contentType: type[0] };
}

// --- the lesson card, as in the timetable, with email-safe inline styles (light theme) ----

const TONES = {
  regular: { bg: null, border: '#e3e3e3', badgeBg: null, badgeFg: null },
  changed: { bg: '#e8f0fe', border: '#0b57d0', badgeBg: '#0b57d0', badgeFg: '#ffffff' },
  added: { bg: '#f4f8ff', border: '#0b57d0', dashed: true, badgeBg: '#dbe6fb', badgeFg: '#0b57d0' },
  cancelled: { bg: '#f5f5f5', border: '#d6d6d6', badgeBg: '#fde7e7', badgeFg: '#b3261e', struck: true },
  freed: { bg: '#f5f5f5', border: '#d6d6d6', badgeBg: '#e6f4ea', badgeFg: '#146c2e', struck: true },
  maybe: { bg: '#fff8e1', border: '#c79a1e', dashed: true, badgeBg: '#fdf0c2', badgeFg: '#7a5a00' },
};

/** `pct`% of `hex` over white: the tint the page uses for regular lessons. */
function tint(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * (pct / 100) + 255 * (1 - pct / 100));
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/** Validated card from the page (strings only, capped), or null. */
export function readCard(card) {
  if (!card || typeof card !== 'object' || !TONES[card.tone]) return null;
  const lines = Array.isArray(card.lines)
    ? card.lines
        .slice(0, 8)
        .map((l) => ({ text: str(l?.text, 300), was: str(l?.was, 300), wasFirst: l?.wasFirst === true }))
        .filter((l) => l.text || l.was)
    : [];
  return {
    tone: card.tone,
    badge: str(card.badge, 80),
    title: str(card.title, 200),
    lines,
    original: str(card.original, 300),
    plain: card.plain === true,
    titleStruck: card.titleStruck === true,
    color: typeof card.color === 'string' && /^#[0-9a-f]{6}$/i.test(card.color) ? card.color : null,
    raw: Array.isArray(card.raw) ? card.raw.slice(0, 6).map((r) => str(r, 400)).filter(Boolean) : [],
  };
}

export function cardHtml(c) {
  const t = TONES[c.tone];
  const color = c.plain ? null : c.color;
  const bg = t.bg || (color ? tint(color, 16) : '#f3f3f3');
  const dot =
    color && c.tone !== 'added'
      ? `<span style="display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:${color};${t.struck ? 'opacity:.35;' : ''}"></span>`
      : '';
  const badge =
    c.badge && t.badgeBg
      ? `<div style="margin:0 0 6px"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${t.badgeBg};color:${t.badgeFg};font-size:11px;font-weight:bold;letter-spacing:.02em;text-transform:uppercase">${escapeHtml(c.badge)}</span></div>`
      : '';
  const struck = t.struck || c.titleStruck;
  const title = `<div style="font-size:14px;font-weight:bold;color:${struck ? '#777777' : '#1f1f1f'};${struck ? 'text-decoration:line-through;' : ''}">${dot}${escapeHtml(c.title)}</div>`;
  const was = (l) => (l.was ? `<s style="font-size:12px;color:#8a8a8a">${escapeHtml(l.was)}</s>` : '');
  const lines = c.lines
    .map(
      (l) =>
        `<div style="font-size:13px;color:${c.tone === 'changed' ? '#1f1f1f' : '#444746'}">${
          l.wasFirst ? `${was(l)} ${escapeHtml(l.text)}` : `${escapeHtml(l.text)} ${was(l)}`
        }</div>`
    )
    .join('');
  const original = c.original ? `<div style="font-size:12px;color:#8a8a8a;text-decoration:line-through">${escapeHtml(c.original)}</div>` : '';
  const raw = c.raw.map((r) => `<div style="margin-top:6px;font-size:12px;color:#8a8a8a">${escapeHtml(r)}</div>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:100%;max-width:360px"><tr><td style="padding:10px 12px;border-radius:12px;background:${bg};border:1px ${t.dashed ? 'dashed' : 'solid'} ${t.border};font-family:Helvetica,Arial,sans-serif;line-height:1.3">${badge}${title}${lines}${original}${raw}</td></tr></table>`;
}

router.post('/timetable', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body || {};
  // Honeypot: a field hidden from people, filled in by bots.
  if (str(body.website, 200)) return res.status(204).end();

  const description = str(body.description, Infinity); // no cap: the 6 MB body limit bounds it
  const expected = str(body.expected, 3000);
  const email = str(body.email, 200);
  if (!description) return res.status(400).json({ error: 'Descrivi il problema' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email non valida' });

  let image = null;
  try {
    image = decodeImage(body.screenshot);
  } catch (err) {
    return res.status(400).json({
      error: err instanceof RangeError ? 'Screenshot troppo grande (max 4 MB)' : 'Lo screenshot deve essere un’immagine PNG, JPEG o WebP',
    });
  }

  if (reportLimited(clientIp(req))) return res.status(429).json({ error: 'Troppe segnalazioni, riprova più tardi' });

  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const rows = CONTEXT_FIELDS.map(([key, label, max]) => [label, str(ctx[key], max)]).filter(([, v]) => v);
  const entity = str(ctx.entity, 120);
  const card = readCard(body.card);

  const subject = `[Orario] Segnalazione${entity ? ` · ${entity}` : ''}${ctx.date ? ` · ${str(ctx.date, 40)}` : ''}`;
  const html = `<!doctype html><div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.4;color:#111">
<h2 style="margin:0 0 12px">Segnalazione orario</h2>
<h3 style="margin:16px 0 4px">Problema</h3><p style="white-space:pre-wrap;margin:0">${escapeHtml(description)}</p>
${expected ? `<h3 style="margin:16px 0 4px">Come dovrebbe essere</h3><p style="white-space:pre-wrap;margin:0">${escapeHtml(expected)}</p>` : ''}
${card ? `<h3 style="margin:16px 0 6px">Lezione segnalata</h3>${cardHtml(card)}` : ''}
<h3 style="margin:16px 0 4px">Contesto</h3>
<table cellpadding="4" style="border-collapse:collapse">${rows
    .map(([l, v]) => `<tr><td style="color:#666;vertical-align:top">${escapeHtml(l)}</td><td style="white-space:pre-wrap">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
<p style="color:#666;margin-top:16px">Contatto: ${email ? escapeHtml(email) : 'nessuno (anonimo)'}${image ? ' · screenshot allegato' : ''}</p>
</div>`;
  const text = [
    'Segnalazione orario',
    '',
    'Problema:',
    description,
    ...(expected ? ['', 'Come dovrebbe essere:', expected] : []),
    '',
    ...rows.map(([l, v]) => `${l}: ${v}`),
    '',
    `Contatto: ${email || 'nessuno (anonimo)'}`,
  ].join('\n');

  try {
    const { via } = await sendReportMail({ subject, html, text, replyTo: email || null, attachments: image ? [image] : [] });
    log.info('Report sent', { via, to: REPORT_EMAIL, screenshot: Boolean(image) });
    res.status(202).json({ ok: true });
  } catch (err) {
    log.error('Report delivery failed', { error: err.message });
    res.status(503).json({ error: 'Invio non riuscito, riprova più tardi' });
  }
});

export default router;
