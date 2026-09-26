import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRainViewerRadar,
  latestRainViewerFrame,
  RAINVIEWER_CREDIT,
  RAINVIEWER_INDEX_URL,
  RAINVIEWER_MAX_LEVEL,
  rainViewerTileTemplate,
} from './rainViewer.js';
import { createWeatherLayer } from './index.js';

const INDEX = {
  version: '2.0',
  host: 'https://evil.example',
  radar: {
    past: [
      { time: 1790406600, path: '/v2/radar/6168306ac308' },
      { time: 1790413800, path: '/v2/radar/a70cec2a334f' },
    ],
    nowcast: [],
  },
};

function fakeCesium() {
  return {
    WebMercatorTilingScheme: class {},
    UrlTemplateImageryProvider: class {
      constructor(options) {
        this.options = options;
      }
    },
  };
}

function fakeCollection() {
  const layers = [];
  return {
    layers,
    addImageryProvider(provider) {
      const layer = { provider, alpha: 1 };
      layers.push(layer);
      return layer;
    },
    remove(layer) {
      layers.splice(layers.indexOf(layer), 1);
    },
  };
}

const jsonResponse = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => body,
});

test('the newest valid past frame wins and foreign paths are refused', () => {
  assert.deepEqual(latestRainViewerFrame(INDEX), {
    time: new Date(1790413800 * 1000).toISOString(),
    path: '/v2/radar/a70cec2a334f',
  });
  const hostile = {
    radar: {
      past: [
        { time: 1790406600, path: '/v2/radar/6168306ac308' },
        { time: 1790413800, path: '//evil.example/x' },
        { time: 1790413900, path: '/v2/radar/../../x' },
      ],
    },
  };
  assert.equal(
    latestRainViewerFrame(hostile).path,
    '/v2/radar/6168306ac308',
    'a bad newest frame falls back to the newest good one',
  );
  assert.equal(latestRainViewerFrame({ radar: { past: [] } }), null);
  assert.equal(latestRainViewerFrame(null), null);
});

test('tiles always come from the fixed RainViewer host, never the index host', () => {
  assert.equal(
    rainViewerTileTemplate('/v2/radar/a70cec2a334f'),
    'https://tilecache.rainviewer.com/v2/radar/a70cec2a334f/256/{z}/{x}/{y}/2/1_0.png',
  );
});

test('refresh drapes the newest frame on the host with credit and zoom cap', async () => {
  const collection = fakeCollection();
  const requested = [];
  const radar = createRainViewerRadar({
    cesium: fakeCesium(),
    getHost: () => ({ collection }),
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse(INDEX);
    },
  });
  radar.setAlpha(0.4);
  assert.equal(await radar.refresh(), true);
  assert.deepEqual(requested, [RAINVIEWER_INDEX_URL]);
  assert.equal(collection.layers.length, 1);
  const { options } = collection.layers[0].provider;
  assert.match(options.url, /a70cec2a334f/);
  assert.equal(options.maximumLevel, RAINVIEWER_MAX_LEVEL);
  assert.equal(options.credit, RAINVIEWER_CREDIT);
  assert.equal(collection.layers[0].alpha, 0.4);
  // Same frame again: nothing is re-added.
  await radar.refresh();
  assert.equal(collection.layers.length, 1);
});

test('a failed refresh keeps the previous frame and says so', async () => {
  const collection = fakeCollection();
  let ok = true;
  const radar = createRainViewerRadar({
    cesium: fakeCesium(),
    getHost: () => ({ collection }),
    fetchImpl: async () => jsonResponse(INDEX, ok),
  });
  await radar.refresh();
  ok = false;
  assert.equal(await radar.refresh(), false);
  assert.equal(collection.layers.length, 1);
  assert.match(radar.getState().error, /previous frame retained/);
  assert.ok(radar.getState().time);
});

test('hiding, rehoming and clearing move or remove the one owned layer', async () => {
  const globe = fakeCollection();
  const tiles = fakeCollection();
  let host = globe;
  const radar = createRainViewerRadar({
    cesium: fakeCesium(),
    getHost: () => ({ collection: host }),
    fetchImpl: async () => jsonResponse(INDEX),
  });
  await radar.refresh();
  host = tiles;
  radar.rehome();
  assert.equal(globe.layers.length, 0);
  assert.equal(tiles.layers.length, 1);
  radar.setHidden(true);
  assert.equal(tiles.layers.length, 0);
  radar.setHidden(false);
  assert.equal(tiles.layers.length, 1);
  radar.clear();
  assert.equal(tiles.layers.length, 0);
  assert.equal(radar.getState().time, null);
});

test('Rain radar World region uses RainViewer instead of the NOAA feed', async () => {
  const calls = [];
  const world = {
    refresh: async () => {
      calls.push('refresh');
      return true;
    },
    setAlpha: () => {},
    setHidden: (hidden) => calls.push(`hidden:${hidden}`),
    rehome: () => {},
    clear: () => calls.push('clear'),
    getState: () => ({
      time: '2026-09-26T10:00:00.000Z',
      loading: false,
      error: null,
    }),
  };
  let noaaRequests = 0;
  const layer = createWeatherLayer({
    id: 'weather-radar',
    feed: {
      getSnapshot: async () => {
        noaaRequests++;
        return { unavailable: true };
      },
    },
    documentRef: null,
    eventTarget: null,
    matchMedia: () => null,
    createRendering: () => ({
      setAlpha() {},
      setHidden() {},
      rehome() {},
      clear() {},
      getDiagnostics: () => ({ time: null, loading: false, error: null }),
    }),
    createWorldRadar: () => world,
  });
  layer.init({ camera: {}, imageryLayers: fakeCollection() });
  layer.enable();

  const chips = layer.getRowControls().summary.settings[0].chips;
  assert.deepEqual(
    chips.map(({ label }) => label),
    ['US', 'World'],
  );
  // Choosing a region starts its own refresh.
  layer.setParams({ product: 'radar-world' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(noaaRequests, 0, 'World never asks NOAA');
  assert.ok(calls.includes('refresh'));
  assert.deepEqual(layer.getParams(), {
    product: 'radar-world',
    opacity: 'strong',
  });
  const controls = layer.getRowControls();
  assert.equal(controls.summary.label, 'Rain radar · World');
  assert.equal(controls.legend.length, 0, 'the NOAA dBZ legend does not apply');
  assert.match(controls.info, /RainViewer · personal use only/);
  assert.equal(layer.getStats().source, 'RainViewer');

  layer.setParams({ product: 'radar' });
  assert.ok(calls.includes('hidden:true'), 'US hides the RainViewer layer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(noaaRequests, 1, 'US asks NOAA again');
  layer.destroy();
});
