// Each Moodle login attempt is a login on the school site: limit them per IP and per
// username so our endpoints cannot be used to guess school passwords. Shared by
// "Accedi con Moodle" on the timetable and by the Moodle account login.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 10;
const MAX_PER_USER = 5;
const attempts = new Map(); // key -> { count, reset }

function tooMany(key, max) {
  const now = Date.now();
  if (attempts.size > 10000) {
    for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
  }
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

/** True when this IP or this username tried too many times recently. Counts the attempt. */
export function schoolLoginLimited(ip, username) {
  const byIp = tooMany(`ip:${ip}`, MAX_PER_IP);
  const byUser = tooMany(`u:${String(username).toLowerCase()}`, MAX_PER_USER);
  return byIp || byUser;
}
