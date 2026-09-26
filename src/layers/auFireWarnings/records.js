/**
 * Normalize Australian state fire feeds into one incident row shape.
 * Pure: no network, no Cesium. Shared by the server proxy and the client.
 *
 * Row: { id, state, level, title, location, status, type, sizeHa, agency,
 *        action, summary, updatedMs, updatedText, url, lat, lon, polygons }
 * `level` follows the Australian Warning System plus two information tiers:
 *   'emergency' | 'watch-act' | 'advice' | 'info' | 'planned-burn'
 */

export const AU_FIRE_LEVELS = Object.freeze([
  'emergency',
  'watch-act',
  'advice',
  'info',
  'planned-burn',
]);

/** Australia's mainland + Tasmania, generously: rejects swapped or bogus points. */
const inAustralia = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= -45 &&
  lat <= -9 &&
  lon >= 112 &&
  lon <= 155;

const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Feed ids arrive as strings or numbers. */
const idOf = (value) =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.trim())
    ? String(value).trim().slice(0, 120)
    : null;

const MAX_TEXT = 600;
const clip = (value) => {
  const s = text(value);
  return s && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
};

/** Only https links on the agency's own domain survive. */
function safeUrl(value, hosts) {
  const s = text(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:') return null;
    return hosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function levelFromWarning(value) {
  const s = String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (s.startsWith('emergency')) return 'emergency';
  if (s.startsWith('watch and act') || s === 'watch & act') return 'watch-act';
  if (s.startsWith('advice')) return 'advice';
  if (s.startsWith('planned burn')) return 'planned-burn';
  return 'info';
}

function validRing(ring) {
  return (
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.length <= 20_000 &&
    ring.every(
      (p) =>
        Array.isArray(p) &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        Math.abs(p[0]) <= 180 &&
        Math.abs(p[1]) <= 90,
    )
  );
}

/**
 * Walk any GeoJSON geometry (including nested collections) and gather its
 * first point and its polygons (each an array of rings).
 */
export function collectGeometry(geometry, out = { point: null, polygons: [] }) {
  if (!geometry || typeof geometry !== 'object') return out;
  const { type, coordinates } = geometry;
  if (type === 'Point' && !out.point && Array.isArray(coordinates)) {
    const [lon, lat] = coordinates;
    if (inAustralia(lat, lon)) out.point = { lat, lon };
  } else if (type === 'Polygon' && Array.isArray(coordinates)) {
    if (coordinates.length && coordinates.every(validRing))
      out.polygons.push(coordinates);
  } else if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
    for (const rings of coordinates)
      if (Array.isArray(rings) && rings.length && rings.every(validRing))
        out.polygons.push(rings);
  } else if (
    type === 'GeometryCollection' &&
    Array.isArray(geometry.geometries)
  ) {
    for (const child of geometry.geometries.slice(0, 64))
      collectGeometry(child, out);
  }
  return out;
}

/** Vertex mean of the largest outer ring — a card anchor, not a true centroid. */
function polygonAnchor(polygons) {
  let best = null;
  for (const rings of polygons)
    if (!best || rings[0].length > best.length) best = rings[0];
  if (!best) return null;
  let lat = 0;
  let lon = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  const anchor = { lat: lat / count, lon: lon / count };
  return inAustralia(anchor.lat, anchor.lon) ? anchor : null;
}

function placeOf(geometry, fallback = null) {
  const { point, polygons } = collectGeometry(geometry);
  const anchor = point || polygonAnchor(polygons) || fallback;
  return anchor ? { ...anchor, polygons } : null;
}

function isoMs(value) {
  const ms = Date.parse(text(value) || '');
  return Number.isFinite(ms) ? ms : null;
}

function hectares(value) {
  const n = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** NSW packs its facts into `KEY: value <br />` lines. */
export function parseNswDescription(description) {
  const fields = {};
  for (const line of String(description || '').split(/<br\s*\/?>/i)) {
    const match = /^\s*([A-Z][A-Z ]+):\s*(.*?)\s*$/.exec(
      line.replace(/<[^>]*>/g, ''),
    );
    if (match) fields[match[1].trim()] = match[2];
  }
  return fields;
}

/** NSW RFS "major incidents" GeoJSON (the Fires Near Me feed). */
export function normalizeNswFeed(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  for (const feature of geojson.features) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const id = /(\d+)\/?$/.exec(String(p.guid || ''))?.[1];
    const place = placeOf(feature.geometry);
    if (!id || !place) continue;
    const f = parseNswDescription(p.description);
    rows.push({
      id: `nsw:${id}`,
      state: 'NSW',
      level: levelFromWarning(p.category),
      title: clip(p.title) || 'Unnamed incident',
      location: clip(f.LOCATION),
      council: clip(f['COUNCIL AREA']),
      status: clip(f.STATUS),
      type: clip(f.TYPE),
      sizeHa: hectares(f.SIZE),
      agency: clip(f['RESPONSIBLE AGENCY']),
      action: null,
      summary: null,
      updatedMs: null,
      updatedText: clip(f.UPDATED),
      url: safeUrl(p.link, ['rfs.nsw.gov.au']),
      ...place,
    });
  }
  return rows;
}

const VIC_FIRE_INCIDENTS = new Set(['Fire', 'Planned Burn']);

/** VicEmergency public feed: keep fire warnings and fire / planned-burn incidents. */
export function normalizeVicFeed(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  for (const feature of geojson.features) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const warning =
      p.feedType === 'warning' &&
      (p.category2 === 'Fire' || p.cap?.category === 'Fire');
    const incident =
      p.feedType === 'incident' && VIC_FIRE_INCIDENTS.has(p.category1);
    if (!warning && !incident) continue;
    const id = idOf(p.id) || idOf(p.sourceId);
    const place = placeOf(feature.geometry);
    if (!id || !place) continue;
    const level = warning
      ? levelFromWarning(p.category1)
      : p.category1 === 'Planned Burn'
        ? 'planned-burn'
        : 'info';
    rows.push({
      id: `vic:${p.feedType}:${id}`,
      state: 'VIC',
      level,
      // The card already leads with the warning level; the title is the place.
      title:
        clip(warning ? p.location : p.sourceTitle || p.location) ||
        'Unnamed incident',
      location: clip(p.location),
      council: null,
      // On warnings `status` is the CAP severity, not the fire's status.
      status: warning ? null : clip(p.status),
      type: clip(warning ? p.cap?.event || 'Bushfire' : p.category2),
      sizeHa: hectares(p.size),
      agency: clip(p.sourceOrg),
      action: clip(p.action),
      summary: null,
      updatedMs: isoMs(p.updated) ?? isoMs(p.created),
      updatedText: null,
      url: safeUrl(p.url, [
        'emergency.vic.gov.au',
        'ffm.vic.gov.au',
        'cfa.vic.gov.au',
      ]),
      ...place,
    });
  }
  return rows;
}

/** Queensland Fire Department current bushfire warnings. */
export function normalizeQldFeed(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  for (const feature of geojson.features) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    if (p.EventType && p.EventType !== 'Fire') continue;
    const id = idOf(p.UniqueID) || idOf(p.OBJECTID);
    const fallback = inAustralia(p.Latitude, p.Longitude)
      ? { lat: p.Latitude, lon: p.Longitude }
      : null;
    const place = placeOf(feature.geometry, fallback);
    if (!id || !place) continue;
    rows.push({
      id: `qld:${id}`,
      state: 'QLD',
      level: levelFromWarning(p.WarningLevel),
      title: clip(p.WarningArea) || clip(p.WarningTitle) || 'Bushfire',
      location: clip(p.WarningArea),
      council: null,
      status: null,
      type: clip(p.GroupedType),
      sizeHa: null,
      agency: 'Queensland Fire Department',
      action: clip(p.CallToAction),
      summary: clip(p.Header || p.WarningText),
      updatedMs:
        isoMs(p.ItemDateTimeLocal_ISO) ?? isoMs(p.PublishDateLocal_ISO),
      updatedText: null,
      url: null,
      ...place,
    });
  }
  return rows;
}

export const AU_FIRE_FEEDS = Object.freeze([
  Object.freeze({
    state: 'NSW',
    url: 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json',
    normalize: normalizeNswFeed,
  }),
  Object.freeze({
    state: 'VIC',
    url: 'https://emergency.vic.gov.au/public/osom-geojson.json',
    normalize: normalizeVicFeed,
  }),
  Object.freeze({
    state: 'QLD',
    url: 'https://publiccontent-gis-psba-qld-gov-au.s3.amazonaws.com/content/Feeds/BushfireCurrentIncidents/bushfireAlert.json',
    normalize: normalizeQldFeed,
  }),
]);
