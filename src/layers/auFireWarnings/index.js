import * as Cesium from 'cesium';
import {
  AU_FIRE_LEVEL_ORDER,
  AU_FIRE_LEVEL_STYLE,
  AU_FIRE_OVERLAY_SOURCE_ID,
  buildAuFireCard,
  isWarningLevel,
} from './cards.js';
export { createAuFireWarningsSource } from './source.js';
export * from './cards.js';
export * from './records.js';

const PICK_PREFIX = 'au-fire:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/**
 * Official Australian fire incidents and warnings (NSW, VIC, QLD) as points
 * coloured by Australian Warning System level, with warning/incident areas
 * where the agency publishes one. Click a point for its card.
 */
export function createAuFireWarningsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fire warnings require a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _clickHandler = null;
  let _rows = [];
  let _sources = [];
  let _signature = null;
  let _show = 'all';
  let _selectedId = null;
  let _selectedCardId = null;
  let _lastUpdate = null;
  let _lastError = null;
  const _rowById = new Map();

  const visibleRows = () =>
    _show === 'warnings'
      ? _rows.filter((row) => isWarningLevel(row.level))
      : _rows;
  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function render() {
    if (!_dataSource) return;
    const entities = [];
    // Least urgent first so urgent points are added last and paint on top.
    const ordered = [...visibleRows()].sort(
      (a, b) =>
        AU_FIRE_LEVEL_ORDER.indexOf(b.level) -
        AU_FIRE_LEVEL_ORDER.indexOf(a.level),
    );
    for (const row of ordered) {
      const style = AU_FIRE_LEVEL_STYLE[row.level] ?? AU_FIRE_LEVEL_STYLE.info;
      const color = Cesium.Color.fromCssColorString(style.color);
      for (const [index, rings] of row.polygons.entries()) {
        const [outer, ...holes] = rings;
        const outerPositions = ringPositions(outer);
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${row.id}:area:${index}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                outerPositions,
                holes.map(
                  (hole) => new Cesium.PolygonHierarchy(ringPositions(hole)),
                ),
              ),
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.18)),
            },
            polyline: {
              positions: outerPositions,
              clampToGround: true,
              width: 2,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.85)),
            },
          }),
        );
      }
      entities.push(
        new Cesium.Entity({
          id: `${PICK_PREFIX}${row.id}`,
          position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          point: {
            pixelSize: style.pixelSize,
            color,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    _dataSource.entities.suspendEvents();
    _dataSource.entities.removeAll();
    for (const entity of entities) _dataSource.entities.add(entity);
    _dataSource.entities.resumeEvents();
    _viewer?.scene?.requestRender?.();
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    const shown = row && (_show === 'all' || isWarningLevel(row.level));
    if (!shown) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(AU_FIRE_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildAuFireCard(row, Date.now()),
      position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
    };
    if (!openExternal) card.interactive = false;
    if (row.url && openExternal) {
      card.activate = () => {
        openExternal(row.url);
        return true;
      };
    }
    _selectedCardId = card.id;
    overlayHost.setEntries(
      AU_FIRE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function pickedRowId(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const rest = pickId.slice(PICK_PREFIX.length);
    const id = rest.replace(/:area:\d+$/, '');
    return _rowById.has(id) ? id : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: AU_FIRE_OVERLAY_SOURCE_ID },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        const row = _rowById.get(_selectedId);
        if (row?.url && openExternal) openExternal(row.url);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const id = picked ? pickedRowId(picked) : null;
      if (id) {
        _selectedId = id;
        publishSelectedCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  function clearSelection() {
    _selectedId = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(AU_FIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(AU_FIRE_OVERLAY_SOURCE_ID, false);
    }
  }

  function sourceProblem() {
    const down = _sources.filter((s) => !s.ok);
    if (!down.length) return null;
    return down
      .map((s) => `${s.state} ${s.stale ? 'delayed' : 'unavailable'}`)
      .join(' · ');
  }

  const layer = {
    id: 'au-fire-warnings',
    name: 'AU Fire Warnings',
    icon: '🔥',
    source: 'NSW RFS · VicEmergency · QLD Fire',
    updateInterval: 180_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Fire warnings layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('au-fire-warnings');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(AU_FIRE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _sources = snapshot.sources;
        const signature = JSON.stringify(snapshot.rows);
        if (signature !== _signature) {
          _signature = signature;
          _rows = snapshot.rows;
          _rowById.clear();
          for (const row of _rows) _rowById.set(row.id, row);
          render();
        }
        if (_selectedId) publishSelectedCard();
        _lastUpdate = Date.now();
        _lastError = sourceProblem();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || 'Fire warnings unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    getParams() {
      return { show: _show };
    },

    setParams(params = {}) {
      if (['all', 'warnings'].includes(params.show) && params.show !== _show) {
        _show = params.show;
        render();
        if (_selectedId) publishSelectedCard();
      }
    },

    getRowControls() {
      const shown = visibleRows();
      return {
        chips: [
          {
            id: 'show-all',
            label: 'All incidents',
            active: _show === 'all',
            params: { show: 'all' },
            title:
              'Every fire incident the agencies publish, with or without a warning',
          },
          {
            id: 'show-warnings',
            label: 'Warnings only',
            active: _show === 'warnings',
            params: { show: 'warnings' },
            title: 'Only Advice, Watch and Act and Emergency Warnings',
          },
        ],
        legend: AU_FIRE_LEVEL_ORDER.filter(
          (level) => _show === 'all' || isWarningLevel(level),
        ).map((level, index) => ({
          label: AU_FIRE_LEVEL_STYLE[level].label,
          color: AU_FIRE_LEVEL_STYLE[level].color,
          count: shown.filter((row) => row.level === level).length,
          ...(index === 0
            ? {
                blurb:
                  'Official NSW, VIC and QLD incidents. Always follow your state emergency service — this map can lag or miss warnings.',
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: visibleRows().length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _sources.some((s) => s.stale),
      };
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _rows = [];
      _signature = null;
      _enabled = false;
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
    },
  };
  return layer;
}
