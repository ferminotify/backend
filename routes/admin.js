// Admin pages: statistics rendered as HTML on the server, no client JavaScript.
//
// Env (the pages are a 404 without these three):
//   ADMIN_PASSWORD                    basic auth, user "admin"
//   ADMIN_DB_USER, ADMIN_DB_PASSWORD  read-only login on the same DB
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import pkg from 'pg';
import logger from '../utils/logger.js';
import { clientIp, adminAuthBlocked, adminAuthFailed } from '../utils/limiter.js';
import { renderPage, renderView } from '../admin/views.js';
import { panoramica } from '../admin/data/panoramica.js';
import { utenti } from '../admin/data/utenti.js';
import { email } from '../admin/data/email.js';
import { notifiche } from '../admin/data/notifiche.js';
import { push } from '../admin/data/push.js';
import { log as logPage } from '../admin/data/log.js';
import { utente } from '../admin/data/utente.js';

const { Pool } = pkg;
const router = express.Router();
const log = logger.child('admin');

const USER = 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENABLED = Boolean(PASSWORD && process.env.ADMIN_DB_USER && process.env.ADMIN_DB_PASSWORD);
if (!ENABLED) log.info('Admin pages disabled (ADMIN_PASSWORD, ADMIN_DB_USER or ADMIN_DB_PASSWORD missing)');

let pool = null;
function db() {
  if (pool) return pool;
  pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_DATABASE,
    user: process.env.ADMIN_DB_USER,
    password: process.env.ADMIN_DB_PASSWORD,
    ssl: process.env.DB_SSL_CERT ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CERT } : false,
    max: 3,
    idleTimeoutMillis: 60000,
  });
  pool.on('connect', (client) => {
    client.query(`SET search_path TO public; SET default_transaction_read_only = on; SET statement_timeout = '15s'`)
      .catch((err) => log.error('Session setup failed', { error: err.message }));
  });
  pool.on('error', (err) => log.error('Idle client error', { error: err.message }));
  return pool;
}

// Constant-time compare of strings of any length.
const sameSecret = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest(),
);

function basicAuth(req, res, next) {
  const ip = clientIp(req);
  if (adminAuthBlocked(ip)) return res.status(429).type('text').send('Troppi tentativi, riprova tra 15 minuti.');
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const ok = colon > 0 && sameSecret(decoded.slice(0, colon), USER) & sameSecret(decoded.slice(colon + 1), PASSWORD);
    if (ok) return next();
    adminAuthFailed(ip);
    log.warn('Wrong admin credentials', { ip });
  }
  res.set('WWW-Authenticate', 'Basic realm="Gestionale Fermi Notify", charset="UTF-8"');
  return res.status(401).type('text').send('Accesso riservato.');
}

router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).type('text').send('Not found');
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});
router.use(basicAuth);

// Font for the pages (Montserrat, SIL Open Font License), behind the same login.
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'assets');
// Script that swaps filtered lists and pages in place (?part=list|main below).
router.get('/assets/admin.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(ASSETS, 'admin.js'));
});
router.get('/assets/montserrat.woff2', (req, res) => {
  res.set('Cache-Control', 'private, max-age=2592000');
  res.sendFile(path.join(ASSETS, 'montserrat.woff2'));
});

// href (relative to the admin root) -> page builder (admin/data/): async (db, req) =>
//   { view, locals, title?, active?, status? } (admin/views/<view>.ejs) | { csv: { filename, body } }
const PAGES = { './': panoramica, utenti, email, notifiche, push, log: logPage };
const READY = Object.keys(PAGES);
// Pages outside the menu (out.active names the menu entry to highlight).
const HIDDEN = { utente };

function page(href) {
  return async (req, res) => {
    // "/admin" without the slash would resolve the relative links one level up.
    if (href === './' && !req.originalUrl.split('?')[0].endsWith('/')) {
      const last = req.originalUrl.split('?')[0].split('/').filter(Boolean).pop();
      return res.redirect(301, `${last}/`);
    }
    try {
      const out = await (PAGES[href] || HIDDEN[href])(db(), req);
      if (out.csv) {
        res.set('Content-Disposition', `attachment; filename="${out.csv.filename}"`);
        return res.type('text/csv; charset=utf-8').send(out.csv.body);
      }

      // ?part=list|main: only that piece, for assets/admin.js.
      const part = req.query.part;
      if (part === 'list' || part === 'main') {
        if (out.title) res.set('X-Page-Title', encodeURIComponent(`${out.title} · Admin Fermi Notify`));
        return res.status(out.status || 200).type('html').send(await renderView(out.view, out.locals, req));
      }
      res.status(out.status || 200).type('html').send(await renderPage(out, { active: href, ready: READY }, req));
    } catch (err) {
      log.error('Admin page failed', { page: href, error: err.message });
      res.status(500).type('html').send(await renderPage({ title: 'Errore', view: 'pages/error', locals: {} }, { active: href, ready: READY }, req)
        .catch(() => 'Errore'));
    }
  };
}

router.get('/', page('./'));
for (const href of READY.filter((h) => h !== './')) router.get(`/${href}`, page(href));
for (const href of Object.keys(HIDDEN)) router.get(`/${href}`, page(href));

export default router;
