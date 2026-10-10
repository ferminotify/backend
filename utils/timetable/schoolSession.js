// Logged-in access to https://www.fermimn.edu.it (Django site). The reserved area adds
// teachers to the timetable. Two kinds of session:
// - the service account from SCHOOL_USERNAME / SCHOOL_PASSWORD (optional; without it
//   these fetches fail and callers fall back to public data);
// - a user's own session, from loginWith() with their school (Moodle) credentials.
//   The password is only forwarded to the school site, never stored or logged.
//
// Login flow: GET /_util/login/ (csrftoken cookie + hidden csrfmiddlewaretoken),
// POST the form with Referer (Django checks it on HTTPS) → 302 + sessionid cookie.
import logger from '../logger.js';

const log = logger.child('timetable:session');

const ORIGIN = new URL(process.env.TIMETABLE_URL || 'https://www.fermimn.edu.it/orario/').origin;
const LOGIN_URL = `${ORIGIN}/_util/login/`;
const USER_AGENT = 'FermiNotify/1.0 (+https://fn.lkev.in)';
// After a failed login wait before retrying, so wrong credentials never hammer the site.
const LOGIN_BACKOFF_MS = 10 * 60 * 1000;

export const hasCredentials = () => Boolean(process.env.SCHOOL_USERNAME && process.env.SCHOOL_PASSWORD);

/** Wrong username/password (the school re-renders the form). */
export class SchoolLoginError extends Error {}
/** A user's session was rejected by the school (expired, logged out, password changed). */
export class SchoolSessionExpired extends Error {}

let cookies = new Map(); // service account: name -> value
let loginPromise = null;
let lastFailure = 0;

function storeCookies(res, jar = cookies) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

const cookieHeader = (jar = cookies) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Logs in with the given credentials. Returns the session cookies ({ sessionid, csrftoken }).
 * Throws SchoolLoginError on wrong credentials.
 */
export async function loginWith(username, password) {
  const jar = new Map();
  const page = await fetch(LOGIN_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  storeCookies(page, jar);
  const html = await page.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!token || !jar.has('csrftoken')) throw new Error('School login page: CSRF token not found');

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(jar),
      Referer: LOGIN_URL,
      Origin: ORIGIN,
    },
    body: new URLSearchParams({ csrfmiddlewaretoken: token, username, password, next: '' }),
    signal: AbortSignal.timeout(15000),
  });
  storeCookies(res, jar);
  // Django answers 302 on success and re-renders the form (200) on bad credentials.
  if (res.status === 200) throw new SchoolLoginError('Wrong school credentials');
  if (res.status !== 302 || !jar.has('sessionid')) throw new Error(`School login failed (status ${res.status})`);
  return { sessionid: jar.get('sessionid'), csrftoken: jar.get('csrftoken') };
}

async function doLogin() {
  cookies = new Map();
  const session = await loginWith(process.env.SCHOOL_USERNAME, process.env.SCHOOL_PASSWORD);
  cookies = new Map(Object.entries(session));
  log.info('Logged in to school site');
}

async function login() {
  if (!hasCredentials()) throw new Error('SCHOOL_USERNAME / SCHOOL_PASSWORD not set');
  if (Date.now() - lastFailure < LOGIN_BACKOFF_MS) throw new Error('School login in backoff after a recent failure');
  if (!loginPromise) {
    loginPromise = doLogin()
      .catch((err) => {
        lastFailure = Date.now();
        cookies = new Map();
        log.error('School login failed', { error: err.message });
        throw err;
      })
      .finally(() => {
        loginPromise = null;
      });
  }
  return loginPromise;
}

const isLoginRedirect = (res) =>
  res.status >= 300 && res.status < 400 && (res.headers.get('location') || '').includes('/_util/login');

// An expired session does not always redirect: /orario/ just renders the public page.
// Logged-in pages carry the logout form.
const LOGOUT_PATH = '/auth/logout/';
const isLoggedInPage = (html) => html.includes(`action="${LOGOUT_PATH}"`);

/**
 * GET a page of the school site logged in. With `session` (a user's cookies) a rejected
 * session throws SchoolSessionExpired; otherwise the service account is used and logs
 * in again once if its session expired.
 */
export async function fetchAuthed(url, { session } = {}) {
  if (session) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(new Map(Object.entries(session))) },
      signal: AbortSignal.timeout(15000),
    });
    if (!isLoginRedirect(res) && !res.ok) throw new Error(`School page ${res.status} for ${url}`);
    const html = isLoginRedirect(res) ? '' : await res.text();
    if (!isLoggedInPage(html)) {
      // Tagged: with the shared cache, another request may be waiting on this fetch.
      throw Object.assign(new SchoolSessionExpired('School session expired'), { session });
    }
    return html;
  }
  if (!cookies.has('sessionid')) await login();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader() },
      signal: AbortSignal.timeout(15000),
    });
    storeCookies(res);
    if (!isLoginRedirect(res) && !res.ok) throw new Error(`School page ${res.status} for ${url}`);
    const html = isLoginRedirect(res) ? '' : await res.text();
    if (isLoggedInPage(html)) return html;
    if (attempt === 0) await login();
  }
  throw new Error('School session rejected after re-login');
}

/** Ends a user's session on the school site (best effort). */
export async function logoutSession(session) {
  try {
    await fetch(`${ORIGIN}${LOGOUT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(new Map(Object.entries(session))),
        Referer: `${ORIGIN}/orario/`,
        Origin: ORIGIN,
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: session.csrftoken || '' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // the session expires on its own anyway
  }
}
