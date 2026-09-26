/**
 * World rain radar from RainViewer's public Weather Maps API: a global radar
 * composite (1,200+ radars, 150+ countries), drawn as web-mercator tiles on the
 * weather imagery host.
 *
 * Terms (2026): free for personal or educational use only; RainViewer must be
 * credited. Limits: past frames only (2 h at 10-minute steps), zoom ≤ 7,
 * 100 requests/IP/minute, Universal Blue color scheme only.
 */
export const RAINVIEWER_INDEX_URL =
  'https://api.rainviewer.com/public/weather-maps.json';
const TILE_HOST = 'https://tilecache.rainviewer.com';
export const RAINVIEWER_MAX_LEVEL = 7;
/** Universal Blue (2), smoothed (1), no snow mask (0). */
const TILE_STYLE = '2/1_0';
export const RAINVIEWER_CREDIT = 'Radar © RainViewer';

/**
 * Parse the frame index. Only the fixed tile host is ever used; a frame path
 * must look like RainViewer's own `/v2/radar/<hex>` so the index cannot steer
 * tile requests anywhere else.
 * @returns {{time: string, path: string}|null} The newest past frame.
 */
export function latestRainViewerFrame(index) {
  const past = index?.radar?.past;
  if (!Array.isArray(past)) return null;
  for (let i = past.length - 1; i >= 0; i--) {
    const frame = past[i];
    if (
      Number.isInteger(frame?.time) &&
      frame.time > 0 &&
      typeof frame.path === 'string' &&
      /^\/v2\/radar\/[0-9a-f]{6,64}$/.test(frame.path)
    )
      return {
        time: new Date(frame.time * 1000).toISOString(),
        path: frame.path,
      };
  }
  return null;
}

export function rainViewerTileTemplate(path) {
  return `${TILE_HOST}${path}/256/{z}/{x}/{y}/${TILE_STYLE}.png`;
}

/**
 * @param {object} options
 * @param {typeof import('cesium')} options.cesium
 * @param {() => {collection: object|null}} options.getHost Weather imagery host.
 * @param {() => void} [options.onChange]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createRainViewerRadar({
  cesium,
  getHost,
  onChange = () => {},
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
}) {
  let frame = null;
  let owned = null; // { layer, collection, path }
  let alpha = 0.8;
  let hidden = false;
  let loading = false;
  let error = null;
  let request = null;

  function remove() {
    if (!owned) return;
    try {
      owned.collection.remove(owned.layer, true);
    } catch {
      // The host collection was already torn down.
    }
    owned = null;
  }

  /** Put the current frame on the current host, replacing a stale layer. */
  function mount() {
    const collection = getHost()?.collection ?? null;
    if (!frame || hidden || !collection) {
      remove();
      return;
    }
    if (owned?.collection === collection && owned.path === frame.path) {
      owned.layer.alpha = alpha;
      return;
    }
    remove();
    const provider = new cesium.UrlTemplateImageryProvider({
      url: rainViewerTileTemplate(frame.path),
      minimumLevel: 0,
      maximumLevel: RAINVIEWER_MAX_LEVEL,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      credit: RAINVIEWER_CREDIT,
      hasAlphaChannel: true,
    });
    const layer = collection.addImageryProvider(provider);
    layer.alpha = alpha;
    owned = { layer, collection, path: frame.path };
  }

  return {
    /** Fetch the frame index and show the newest frame. */
    async refresh({ signal } = {}) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('RainViewer request timed out')),
        timeoutMs,
      );
      loading = true;
      onChange();
      try {
        const response = await fetchImpl(RAINVIEWER_INDEX_URL, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`RainViewer HTTP ${response.status}`);
        const next = latestRainViewerFrame(await response.json());
        if (controller.signal.aborted || request !== controller) return false;
        if (!next) throw new Error('RainViewer has no radar frames');
        frame = next;
        error = null;
        mount();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        // Keep the previous frame on screen; say why it is not updating.
        error = frame
          ? 'RainViewer unavailable; previous frame retained'
          : cause?.message || 'RainViewer unavailable';
        return false;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          onChange();
        }
      }
    },
    setAlpha(value) {
      alpha = value;
      if (owned) owned.layer.alpha = alpha;
    },
    setHidden(value) {
      hidden = Boolean(value);
      mount();
    },
    /** The map source changed: move the frame to the new host. */
    rehome() {
      mount();
    },
    clear() {
      request?.abort();
      request = null;
      remove();
      frame = null;
      loading = false;
      error = null;
    },
    getState() {
      return { time: frame?.time ?? null, loading, error };
    },
  };
}
