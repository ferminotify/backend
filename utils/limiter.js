// Rate limits

const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80:)/i;

const bare = (ip) => String(ip || '').replace(/^::ffff:/i, '');

export function clientIp(req) {
  const remote = bare(req.socket?.remoteAddress || req.ip);
  if (!PRIVATE.test(remote)) return remote;
  const header = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const trusted = header && bare(String(req.headers[header] || '').split(',')[0].trim());
  if (trusted) return trusted;
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => bare(s.trim()))
    .filter(Boolean);
  return hops[hops.length - 1] || remote;
}

/** `limited(key)` counts an attempt: true when over `max` in `windowMs` (from the first one). */
function createLimiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map(); // key -> { count, reset }
  return function limited(key) {
    const now = Date.now();
    if (hits.size > maxKeys) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Moodle logins (each one is a request to IS Fermi): per IP, per username, all together
const schoolLoginByIp = createLimiter({ windowMs: 15 * MINUTE_MS, max: 10 });
const schoolLoginByUser = createLimiter({ windowMs: 15 * MINUTE_MS, max: 5 });
const schoolLoginAll = createLimiter({ windowMs: MINUTE_MS, max: 30 });
// Wrong passwords per username in a day: nobody can get a school account locked through us
const SCHOOL_FAILURES_MAX = 8;
const schoolFailures = new Map(); // username -> { count, reset }
const userKey = (username) => String(username).toLowerCase();

/** True when this IP, this username or everyone tried too many times recently. Counts the attempt. */
export function schoolLoginLimited(ip, username) {
  const failures = schoolFailures.get(userKey(username));
  if (failures && failures.reset > Date.now() && failures.count >= SCHOOL_FAILURES_MAX) return true;
  const byIp = schoolLoginByIp(ip);
  const byUser = schoolLoginByUser(userKey(username));
  return byIp || byUser || schoolLoginAll('all');
}

/** A wrong password for this username on the school site. */
export function schoolLoginFailed(username) {
  const now = Date.now();
  const entry = schoolFailures.get(userKey(username));
  if (entry && entry.reset > now) entry.count += 1;
  else schoolFailures.set(userKey(username), { count: 1, reset: now + DAY_MS });
  if (schoolFailures.size > 10000) for (const [k, v] of schoolFailures) if (v.reset < now) schoolFailures.delete(k);
}

/** A successful login clears the username's failures. */
export const schoolLoginSucceeded = (username) => schoolFailures.delete(userKey(username));

// Public event search, per IP (the notifier is not limited)
export const searchLimited = createLimiter({ windowMs: MINUTE_MS, max: 30 });

// Reports: per IP and overall; per day well under Gmail's ~500 messages a day
const reportByIp = createLimiter({ windowMs: HOUR_MS, max: 5, maxKeys: 5000 });
const REPORT_MAX_PER_HOUR = 60;
const REPORT_MAX_PER_DAY = 200;
let reportHour = { count: 0, reset: 0 };
let reportDay = { count: 0, reset: 0 };

export function reportLimited(ip) {
  const now = Date.now();
  if (reportHour.reset < now) reportHour = { count: 0, reset: now + HOUR_MS };
  if (reportDay.reset < now) reportDay = { count: 0, reset: now + DAY_MS };
  if (reportByIp(ip)) return true;
  if (reportHour.count >= REPORT_MAX_PER_HOUR || reportDay.count >= REPORT_MAX_PER_DAY) return true;
  reportHour.count += 1;
  reportDay.count += 1;
  return false;
}

// Admin pages (routes/admin.js): wrong basic-auth credentials per IP, then locked out for the window
const ADMIN_FAILURES_MAX = 10;
const adminFailures = new Map(); // ip -> { count, reset }

/** True when this IP got the admin credentials wrong too many times recently. */
export function adminAuthBlocked(ip) {
  const entry = adminFailures.get(ip);
  return !!entry && entry.reset > Date.now() && entry.count >= ADMIN_FAILURES_MAX;
}

/** A wrong admin username or password from this IP. */
export function adminAuthFailed(ip) {
  const now = Date.now();
  const entry = adminFailures.get(ip);
  if (entry && entry.reset > now) entry.count += 1;
  else adminFailures.set(ip, { count: 1, reset: now + 15 * MINUTE_MS });
  if (adminFailures.size > 5000) for (const [k, v] of adminFailures) if (v.reset < now) adminFailures.delete(k);
}
