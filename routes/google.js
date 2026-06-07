import express from 'express';
import crypto from 'crypto';
import pool from '../db.js';
import logger from '../utils/logger.js';
import { generateRefreshToken } from '../utils/auth.js';
import { getTelegramTemporaryCode } from '../utils/telegram.js';
import { sendWelcomeEmail } from '../utils/email.js';
import {
  isGoogleConfigured,
  buildConsentUrl,
  exchangeCodeForProfile,
  FRONTEND_BASE,
} from '../utils/google.js';

const router = express.Router();
const log = logger.child('google-oauth');

const STATE_COOKIE = 'g_oauth_state';
const isProd = process.env.NODE_ENV === 'production';

// The state cookie must survive the cross-site redirect back from Google.
// Prod (HTTPS): SameSite=None + Secure is the reliable choice. Dev (http://localhost):
// SameSite=None is rejected without Secure, and Secure is dropped on plain http, so use Lax.
const STATE_COOKIE_OPTS = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  maxAge: 10 * 60 * 1000, // 10 minutes
};

// Redirect helper to the SPA, carrying an error message in the query string.
function redirectError(res, message) {
  const url = `${FRONTEND_BASE}/login?error=${encodeURIComponent(message)}`;
  return res.redirect(url);
}

/* Step 1: kick off the OAuth dance. */
router.get('/', (req, res) => {
  if (!isGoogleConfigured()) {
    log.error('Google OAuth requested but GOOGLE_CLIENT_ID/SECRET not configured');
    return redirectError(res, 'Accesso con Google non disponibile.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  res.cookie(STATE_COOKIE, state, STATE_COOKIE_OPTS);

  return res.redirect(buildConsentUrl(state));
});

/* Step 2: Google redirects back here with code + state. */
router.get('/callback', async (req, res) => {
  const { code, state, error: googleError } = req.query;

  if (googleError) {
    log.warn('Google returned an error on callback', { error: googleError });
    return redirectError(res, 'Accesso con Google annullato.');
  }

  // CSRF: state from query must match the cookie set in step 1.
  const cookieState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' });
  if (!code || !state || !cookieState || state !== cookieState) {
    log.warn('Invalid OAuth state or missing code', {
      hasCode: !!code,
      hasState: !!state,
      hasCookie: !!cookieState,
      stateMatches: !!cookieState && state === cookieState,
      cookieNames: Object.keys(req.cookies || {}),
    });
    return redirectError(res, 'Sessione di accesso non valida. Riprova.');
  }

  let payload;
  try {
    payload = await exchangeCodeForProfile(code);
  } catch (e) {
    log.error('Failed to exchange Google code', { error: e.stack || e });
    return redirectError(res, 'Accesso con Google fallito. Riprova.');
  }

  const googleId = payload?.sub;
  const email = payload?.email?.trim().toLowerCase();
  const emailVerified = payload?.email_verified;
  const givenName = payload?.given_name || payload?.name || '';
  const familyName = payload?.family_name || '';

  if (!googleId || !email) {
    log.error('Google payload missing sub/email', { hasSub: !!googleId, hasEmail: !!email });
    return redirectError(res, 'Google non ha fornito i dati necessari.');
  }
  if (!emailVerified) {
    log.warn('Google email not verified', { email });
    return redirectError(res, 'La tua email Google non è verificata.');
  }

  let userId;
  let isNew = false;

  try {
    // 1) Existing Google-linked account.
    const byGoogle = await pool.query(
      'SELECT id FROM subscribers WHERE google_id = $1',
      [googleId]
    );
    if (byGoogle.rowCount > 0) {
      userId = byGoogle.rows[0].id;
    } else {
      // 2) Existing account with the same (verified) email → auto-link.
      const byEmail = await pool.query(
        'SELECT id FROM subscribers WHERE email = $1',
        [email]
      );
      if (byEmail.rowCount > 0) {
        userId = byEmail.rows[0].id;
        await pool.query('UPDATE subscribers SET google_id = $1 WHERE id = $2', [googleId, userId]);
        log.info('Linked Google account to existing user', { id: userId, email });
      } else {
        // 3) Brand-new account. gender='X' placeholder, profile_complete=false
        //    triggers the completion step on the frontend. Email already verified
        //    by Google, so notifications=0 (no email-confirmation flow).
        //    telegram = temp code used to link the Telegram bot (same as password signup).
        const telegramTemporaryCode = await getTelegramTemporaryCode();
        const ins = await pool.query(
          `INSERT INTO subscribers
             (name, surname, email, google_id, gender, notifications, notification_preferences, profile_complete, telegram)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, unsub_token`,
          [givenName, familyName, email, googleId, 'X', 0, 2, false, telegramTemporaryCode]
        );
        userId = ins.rows[0].id;
        isNew = true;
        log.info('Created new user via Google', { id: userId, email });

        try {
          await sendWelcomeEmail(email, {
            name: givenName,
            gender: 'X',
            unsubInfo: { id: userId, unsub_token: ins.rows[0].unsub_token },
          });
        } catch (mailErr) {
          // Non-fatal: account exists, just log.
          log.error('Failed to send welcome email for Google signup', { id: userId, error: mailErr.stack || mailErr });
        }
      }
    }
  } catch (e) {
    log.error('DB error during Google callback', { error: e.stack || e });
    return redirectError(res, 'Errore interno. Riprova più tardi.');
  }

  // Issue a refresh token (httpOnly cookie) — same session model as password login.
  let refreshToken;
  try {
    refreshToken = await generateRefreshToken(userId, 365 * 24 * 60 * 60 * 1000);
  } catch (e) {
    log.error('Failed to generate refresh token for Google login', { id: userId, error: e.stack || e });
    return redirectError(res, 'Errore interno. Riprova più tardi.');
  }

  try {
    await pool.query(
      "UPDATE subscribers SET last_login = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
      [userId]
    );
  } catch (e) {
    log.warn('Failed to update last_login (Google)', { id: userId, error: e.stack || e });
  }

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  log.info('Google login success', { id: userId, isNew, ip: req.ip });
  // The SPA landing page mints an access token via /refresh_token, then routes
  // to /complete-profile (new=1) or /dashboard.
  return res.redirect(`${FRONTEND_BASE}/auth/callback?new=${isNew ? 1 : 0}`);
});

export default router;
