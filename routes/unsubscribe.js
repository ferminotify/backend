// Unsubscribe from notification emails, with the link every email carries (unsub_token).
// POST: one-click unsubscribe (RFC 8058): Gmail and other clients POST to the
//   List-Unsubscribe URL when "Annulla iscrizione" is pressed; the footer page does the same.
// GET: never changes anything (mail scanners open links): redirects to the page with the button.
import express from 'express';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { FRONTEND_BASE } from '../utils/google.js';

const router = express.Router();
const log = logger.child('unsubscribe');

const params = (req) => ({
  id: Number(req.query.id ?? req.body?.id),
  token: String(req.query.token ?? req.body?.token ?? ''),
});

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { id, token } = params(req);
  if (!Number.isInteger(id) || id <= 0 || !/^[0-9a-f-]{8,64}$/i.test(token)) {
    return res.status(400).json({ error: 'Link non valido' });
  }
  try {
    // notification_preferences: 0 none, 1 Telegram, 2 email, 3 both → drop the email bit
    const { rows } = await pool.query(
      'UPDATE subscribers SET notification_preferences = notification_preferences & 1 WHERE id = $1 AND unsub_token::text = $2 RETURNING notification_preferences',
      [id, token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link non valido o account non trovato' });
    log.info('Unsubscribed from emails', { id, oneClick: req.body?.['List-Unsubscribe'] === 'One-Click' });
    res.json({ ok: true, telegram: rows[0].notification_preferences === 1 });
  } catch (err) {
    log.error('Unsubscribe failed', { id, error: err.message });
    res.status(500).json({ error: 'Si è verificato un errore. Riprova più tardi.' });
  }
});

router.get('/', (req, res) => {
  const q = new URLSearchParams({ id: String(req.query.id || ''), token: String(req.query.token || '') });
  res.redirect(303, `${FRONTEND_BASE}/auth/unsubscribe?${q}`);
});

export default router;
