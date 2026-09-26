import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request the merged snapshot through the same-origin /api/au-fire-warnings proxy. */
export function createAuFireWarningsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/au-fire-warnings', { signal });
      if (!response.ok)
        throw new Error(`Fire warnings HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        32 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows) || !Array.isArray(payload?.sources))
        throw new Error('Malformed fire warnings snapshot');
      return payload;
    },
  };
}
