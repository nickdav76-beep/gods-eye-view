import { AU_FIRE_FEEDS } from '../../src/layers/auFireWarnings/records.js';
import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const MIB = 1024 * 1024;
const TTL_MS = 180_000;
const TIMEOUT_MS = 20_000;
/** A state's last good rows keep serving through its outage, up to this age. */
const MAX_STALE_MS = 6 * 3600_000;

/**
 * Fixed-origin Australian fire warnings: NSW RFS, VicEmergency and Queensland
 * Fire Department feeds merged into one normalized snapshot at
 * /api/au-fire-warnings. The proxy only ever fetches the three registered
 * URLs; a failing state keeps its last good rows (marked stale) so one
 * agency's outage never blanks the others.
 */
export function auFireWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  feeds = AU_FIRE_FEEDS,
} = {}) {
  const lastGood = new Map(); // state -> { rows, fetchedAt }
  let snapshot = null;
  let inFlight = null;
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });

  async function fetchFeed(feed) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(feed.url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const rows = feed.normalize(
      await readResponseJsonCapped(response, 24 * MIB, signal),
    );
    if (!Array.isArray(rows)) throw new Error('invalid_feed');
    return rows;
  }

  async function refresh() {
    const results = await Promise.allSettled(feeds.map(fetchFeed));
    const at = now();
    const sources = [];
    const rows = [];
    feeds.forEach((feed, index) => {
      const result = results[index];
      if (result.status === 'fulfilled') {
        lastGood.set(feed.state, { rows: result.value, fetchedAt: at });
        rows.push(...result.value);
        sources.push({
          state: feed.state,
          ok: true,
          count: result.value.length,
        });
        return;
      }
      const kept = lastGood.get(feed.state);
      const usable = kept && at - kept.fetchedAt < MAX_STALE_MS;
      if (usable) rows.push(...kept.rows);
      sources.push({
        state: feed.state,
        ok: false,
        stale: Boolean(usable),
        count: usable ? kept.rows.length : 0,
        ...(usable ? { fetchedAt: kept.fetchedAt } : {}),
      });
    });
    if (!sources.some((source) => source.ok || source.stale))
      throw new Error('all_feeds_unavailable');
    return { fetchedAt: at, sources, rows };
  }

  async function current() {
    if (snapshot && now() - snapshot.fetchedAt < TTL_MS) return snapshot;
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    snapshot = await inFlight;
    return snapshot;
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      json(200, await current());
    } catch {
      json(502, { error: 'au_fire_warnings_unavailable' });
    }
  }

  return {
    name: 'au-fire-warnings',
    configureServer({ middlewares }) {
      middlewares.use('/api/au-fire-warnings', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/au-fire-warnings', handler);
    },
    /** For tests: the merged snapshot without HTTP. */
    current,
  };
}
