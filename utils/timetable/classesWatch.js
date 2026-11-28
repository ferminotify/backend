// Rebuilds the frontend when the school's classes change (in practice at the start of the
// school year)
import logger from '../logger.js';

const log = logger.child('timetable:classes-watch');

const STATE_KEY = 'timetable.classes';

/**
 * Days around the start of the school year when the school publishes the
 * new classes: 25 August to 31 October
 */
export function inNewYearWindow(date = new Date()) {
  const month = date.getMonth(); // 0-based
  return (month === 7 && date.getDate() >= 25) || month === 8 || month === 9;
}

/** Class keys of an index, sorted and without duplicates. */
export const classKeys = (index) => [...new Set((index?.class || []).map((c) => c.key).filter(Boolean))].sort();

// Default storage and trigger; injected in tests.
const defaults = {
  async readState(key) {
    const { default: pool } = await import('../../db.js');
    const { rows } = await pool.query('SELECT value FROM public.app_state WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  },
  async writeState(key, value) {
    const { default: pool } = await import('../../db.js');
    await pool.query(
      `INSERT INTO public.app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
  },
  async triggerBuild(hookUrl) {
    const res = await fetch(hookUrl, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Deploy hook HTTP ${res.status}`);
  },
};

/**
 * Compares the classes of a freshly fetched public index with the last ones seen and, if
 * they changed, starts a frontend build. Never throws.
 * @returns {Promise<'disabled'|'empty'|'suspicious'|'initial'|'unchanged'|'rebuild'|'error'>}
 */
export async function checkClasses(index, deps = {}) {
  const { readState, writeState, triggerBuild } = { ...defaults, ...deps };
  const hookUrl = deps.hookUrl ?? process.env.CF_PAGES_DEPLOY_HOOK;
  if (!hookUrl) return 'disabled';

  const keys = classKeys(index);
  // An empty or broken page from the school must not publish a site without classes.
  if (!keys.length) return 'empty';

  try {
    const stored = await readState(STATE_KEY);
    const previous = stored ? stored.split(',') : null;
    const current = keys.join(',');
    if (stored === current) return 'unchanged';

    if (!previous) {
      // First run (or new database): remember them; the deployed site was built from them.
      await writeState(STATE_KEY, current);
      log.info('Timetable classes recorded', { count: keys.length });
      return 'initial';
    }
    if (keys.length < previous.length / 2) {
      log.warn('Timetable classes: far fewer than before, not rebuilding', { before: previous.length, now: keys.length });
      return 'suspicious';
    }

    const added = keys.filter((k) => !previous.includes(k));
    const removed = previous.filter((k) => !keys.includes(k));
    // Build first, then remember: if the hook fails, the next index refresh tries again.
    await triggerBuild(hookUrl);
    await writeState(STATE_KEY, current);
    log.info('Timetable classes changed: frontend rebuild started', { added, removed });
    return 'rebuild';
  } catch (err) {
    log.error('Timetable classes check failed', { error: err.message });
    return 'error';
  }
}
