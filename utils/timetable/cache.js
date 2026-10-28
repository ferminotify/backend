// Tiny TTL cache with in-flight de-duplication and stale fallback:
// - concurrent callers for the same key share one upstream request;
// - when a refresh fails, the last good value is served (marked stale) instead of an error.
// `ttlMs`: a number, or a function of the cached value returning it (read on each lookup).

export function createCache({ ttlMs, maxEntries = 500 }) {
  const entries = new Map(); // key -> { value, at }
  const inflight = new Map(); // key -> Promise

  async function get(key, load) {
    const hit = entries.get(key);
    const ttl = typeof ttlMs === 'function' ? ttlMs(hit?.value) : ttlMs;
    if (hit && Date.now() - hit.at < ttl) return { value: hit.value, stale: false };

    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          try {
            const value = await load();
            entries.set(key, { value, at: Date.now() });
            if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
            return { value, stale: false };
          } catch (err) {
            if (hit) return { value: hit.value, stale: true, error: err };
            throw err;
          } finally {
            inflight.delete(key);
          }
        })()
      );
    }
    return inflight.get(key);
  }

  /** The last value stored for `key`, however old, without loading; undefined if none. */
  const peek = (key) => entries.get(key)?.value;

  return { get, peek, clear: () => entries.clear() };
}
