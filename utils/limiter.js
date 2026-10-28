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
export function createLimiter({ windowMs, max, maxKeys = 10000 }) {
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

// Moodle logins (each one is a request to IS Fermi): per IP and per username
const schoolLoginByIp = createLimiter({ windowMs: 15 * MINUTE_MS, max: 10 });
const schoolLoginByUser = createLimiter({ windowMs: 15 * MINUTE_MS, max: 5 });

/** True when this IP or this username tried too many times recently. Counts the attempt. */
export function schoolLoginLimited(ip, username) {
  const byIp = schoolLoginByIp(ip);
  const byUser = schoolLoginByUser(String(username).toLowerCase());
  return byIp || byUser;
}

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
