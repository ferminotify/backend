// Logged-in access to https://www.fermimn.edu.it (Django site). The reserved area adds
// teachers to the timetable, for the accounts the school allows. Only users' own sessions,
// from loginWith() with their school (Moodle) credentials: the password is only forwarded
// to the school site, never stored or logged.
//
// Login flow: GET /_util/login/ (csrftoken cookie + hidden csrfmiddlewaretoken),
// POST the form with Referer (Django checks it on HTTPS) → 302 + sessionid cookie.
const ORIGIN = new URL(process.env.TIMETABLE_URL || 'https://www.fermimn.edu.it/orario/').origin;
const LOGIN_URL = `${ORIGIN}/_util/login/`;
// Sent with every request to the school site (also by school.js).
export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  'sec-ch-ua': '"Brave";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
};

/** Wrong username/password (the school re-renders the form). */
export class SchoolLoginError extends Error {}
/** A user's session was rejected by the school (expired, logged out, password changed). */
export class SchoolSessionExpired extends Error {}

function storeCookies(res, jar) {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Logs in with the given credentials. Returns the session cookies ({ sessionid, csrftoken }).
 * Throws SchoolLoginError on wrong credentials.
 */
export async function loginWith(username, password) {
  const jar = new Map();
  const page = await fetch(LOGIN_URL, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) });
  storeCookies(page, jar);
  const html = await page.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!token || !jar.has('csrftoken')) throw new Error('School login page: CSRF token not found');

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...BROWSER_HEADERS,
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

const isLoginRedirect = (res) =>
  res.status >= 300 && res.status < 400 && (res.headers.get('location') || '').includes('/_util/login');

// An expired session does not always redirect: /orario/ just renders the public page.
// Logged-in pages carry the logout form.
const LOGOUT_PATH = '/auth/logout/';
const isLoggedInPage = (html) => html.includes(`action="${LOGOUT_PATH}"`);

/**
 * GET a page of the school site with a user's session (their cookies).
 * A rejected session throws SchoolSessionExpired.
 */
export async function fetchAuthed(url, { session }) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { ...BROWSER_HEADERS, Cookie: cookieHeader(new Map(Object.entries(session))) },
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

/** Ends a user's session on the school site (best effort). */
export async function logoutSession(session) {
  try {
    await fetch(`${ORIGIN}${LOGOUT_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...BROWSER_HEADERS,
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
