// Admin pages ("Gestionale"): statistics rendered as HTML on the server, no client JavaScript.
//   staging: https://staging.fn.lkev.in/api/admin/      production: https://api.fn.lkev.in/admin/
// Mounted before CORS and the media router (server.js). Links between pages are relative, so the same
// pages work under any prefix the proxy adds.
//
// Env (the pages are a 404 when ADMIN_PASSWORD or ADMIN_DB_PASSWORD is missing):
//   ADMIN_USER, ADMIN_PASSWORD        basic auth
//   ADMIN_DB_USER, ADMIN_DB_PASSWORD  read-only login, default user admin_ro (staging/metabase/grants.sql with that
//                                     role name: no password hashes, codes, tokens or push keys)
//   ADMIN_DB_HOST, ADMIN_DB_PORT      server to read, when not DB_HOST/DB_PORT (staging: production)
//   ADMIN_DB_SSL                      'true' = TLS with certificate check (ADMIN_DB_SSL_CERT or DB_SSL_CERT, else the
//                                     system CAs); default: as db.js, TLS when DB_SSL_CERT is set
//   ADMIN_DB_SCHEMA                   'public' (default), or 'demo' for the made-up data on staging
//   ADMIN_DB_DATABASE                 database to read, when not DB_DATABASE (staging: a copy of production)
//   ADMIN_DATA_NOTE                   banner on every page saying which data these are (staging)
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import pkg from 'pg';
import logger from '../utils/logger.js';
import { clientIp, adminAuthBlocked, adminAuthFailed } from '../utils/limiter.js';
import { layout, html } from '../admin/ui.js';
import { panoramica } from '../admin/panoramica.js';
import { utenti } from '../admin/utenti.js';
import { email } from '../admin/email.js';
import { notifiche } from '../admin/notifiche.js';
import { push } from '../admin/push.js';
import { log as logPage } from '../admin/log.js';
import { utente } from '../admin/utente.js';

const { Pool } = pkg;
const router = express.Router();
const log = logger.child('admin');

const USER = process.env.ADMIN_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCHEMA = process.env.ADMIN_DB_SCHEMA || 'public';
const NOTE = process.env.ADMIN_DATA_NOTE || (SCHEMA !== 'public' ? `Dati di prova (schema ${SCHEMA}): non sono iscritti veri.` : '');
const ENABLED = Boolean(PASSWORD && process.env.ADMIN_DB_PASSWORD) && /^[a-z_][a-z0-9_]*$/.test(SCHEMA);
if (!ENABLED) log.info('Admin pages disabled (ADMIN_PASSWORD, ADMIN_DB_PASSWORD or ADMIN_DB_SCHEMA missing or invalid)');

// Read-only on two levels: the role has SELECT only, and every transaction is read-only anyway.
function adminSsl() {
  const ca = process.env.ADMIN_DB_SSL_CERT || process.env.DB_SSL_CERT;
  if (process.env.ADMIN_DB_SSL === 'true') return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  return process.env.DB_SSL_CERT ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CERT } : false;
}

let pool = null;
function db() {
  if (pool) return pool;
  pool = new Pool({
    host: process.env.ADMIN_DB_HOST || process.env.DB_HOST,
    port: Number(process.env.ADMIN_DB_PORT || process.env.DB_PORT || 5432),
    database: process.env.ADMIN_DB_DATABASE || process.env.DB_DATABASE,
    user: process.env.ADMIN_DB_USER || 'admin_ro',
    password: process.env.ADMIN_DB_PASSWORD,
    ssl: adminSsl(),
    max: 3,
    idleTimeoutMillis: 60000,
  });
  pool.on('connect', (client) => {
    client.query(`SET search_path TO "${SCHEMA}"; SET default_transaction_read_only = on; SET statement_timeout = '15s'`)
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

// href (relative to the admin root) -> page builder: async (db, req) => { title, body } | { csv: { filename, body } }
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
      // Pieces for assets/admin.js: one list (the page ran only its queries) or the page content.
      const part = req.query.part;
      if (part === 'list' || part === 'main') {
        if (out.title && !out.fragment) res.set('X-Page-Title', encodeURIComponent(`${out.title} · Admin Fermi Notify`));
        return res.status(out.status || 200).type('html').send(String(out.fragment ?? out.body));
      }
      res.status(out.status || 200).type('html').send(layout({ active: href, ...out, note: NOTE, ready: READY }));
    } catch (err) {
      log.error('Admin page failed', { page: href, error: err.message });
      res.status(500).type('html').send(layout({
        title: 'Errore', active: href, note: NOTE, ready: READY,
        body: html`<div class="error">La pagina non si è caricata: errore nel database. Dettagli nei log del backend.</div>`,
      }));
    }
  };
}

router.get('/', page('./'));
for (const href of READY.filter((h) => h !== './')) router.get(`/${href}`, page(href));
for (const href of Object.keys(HIDDEN)) router.get(`/${href}`, page(href));

export default router;
