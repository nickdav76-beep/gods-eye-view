import assert from 'node:assert/strict';
import test from 'node:test';
import {
  levelFromWarning,
  normalizeNswFeed,
  normalizeQldFeed,
  normalizeVicFeed,
  parseNswDescription,
} from './records.js';
import { buildAuFireCard, isWarningLevel } from './cards.js';
import { auFireWarningsProxy } from '../../../server/providers/auFireWarnings.js';

const square = (lon, lat, d = 0.01) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ],
];

const NSW = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [152.45, -32.19] },
          {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Polygon', coordinates: square(152.44, -32.2) },
            ],
          },
        ],
      },
      properties: {
        title: 'AERODROME ROAD, MINIMBAH',
        link: 'https://www.rfs.nsw.gov.au/fire-information/fires-near-me',
        category: 'Watch and Act',
        guid: 'https://incidents.rfs.nsw.gov.au/api/v1/incidents/679389',
        description:
          'ALERT LEVEL: Watch and Act <br />LOCATION: AERODROME ROAD, MINIMBAH 2428 <br />COUNCIL AREA: Mid-Coast <br />STATUS: Being controlled <br />TYPE: Grass Fire <br />FIRE: Yes <br />SIZE: 1,054 ha <br />RESPONSIBLE AGENCY: Rural Fire Service <br />UPDATED: 26 Sep 2026 17:16',
      },
    },
    {
      // Off-domain link, and a point far outside Australia.
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4, 37.7] },
      properties: {
        title: 'NOWHERE',
        category: 'Advice',
        link: 'https://evil.example/x',
        guid: 'https://incidents.rfs.nsw.gov.au/api/v1/incidents/1',
      },
    },
  ],
};

const VIC = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [147.44, -38.15] },
          { type: 'Polygon', coordinates: square(147.4, -38.2) },
        ],
      },
      properties: {
        feedType: 'warning',
        id: '43197',
        category1: 'Emergency Warning',
        category2: 'Fire',
        status: 'Minor',
        location: 'Seacombe',
        action: 'Leave Now',
        updated: '2026-09-24T09:08:20+10:00',
        cap: { category: 'Fire', event: 'Bushfire' },
      },
    },
    {
      // Numeric ids must survive.
      geometry: { type: 'Point', coordinates: [144.959, -35.9628] },
      properties: {
        feedType: 'incident',
        id: 102737006,
        category1: 'Fire',
        category2: 'Bushfire',
        status: 'Under Control',
        size: '12.5',
        sourceTitle: 'Echuca Road',
        url: 'https://www.ffm.vic.gov.au/x',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [141.9, -36.7] },
      properties: {
        feedType: 'incident',
        id: 3022421,
        category1: 'Planned Burn',
        category2: 'Planned Burn',
      },
    },
    {
      // Not a fire: dropped.
      geometry: { type: 'Point', coordinates: [145, -37] },
      properties: { feedType: 'incident', id: 9, category1: 'Flooding' },
    },
    {
      // Burn areas are history, not incidents: dropped.
      geometry: { type: 'Polygon', coordinates: square(145, -37) },
      properties: { feedType: 'burn-area', id: 10, category1: 'Burn Area' },
    },
  ],
};

const QLD = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Polygon', coordinates: square(152.08, -27.72) },
      properties: {
        UniqueID: 'WARN-824',
        WarningLevel: 'Advice',
        WarningArea: 'Fordsdale, Rockmount and West Haldon',
        CallToAction: 'Stay Informed',
        Header: 'A fire is burning near Spinach Creek Road.',
        GroupedType: 'FIRE VEGETATION',
        EventType: 'Fire',
        Latitude: -27.7185,
        Longitude: 152.0811,
        ItemDateTimeLocal_ISO: '2026-09-26T10:53:27+10:00',
      },
    },
    {
      geometry: { type: 'Point', coordinates: [150, -25] },
      properties: {
        OBJECTID: 3685,
        WarningLevel: 'Information',
        EventType: 'Fire',
      },
    },
  ],
};

test('warning levels map to the Australian Warning System', () => {
  assert.equal(levelFromWarning('Emergency Warning'), 'emergency');
  assert.equal(levelFromWarning('Watch and Act'), 'watch-act');
  assert.equal(levelFromWarning('Advice'), 'advice');
  assert.equal(levelFromWarning('Planned Burn'), 'planned-burn');
  assert.equal(levelFromWarning('Not Applicable'), 'info');
  assert.equal(levelFromWarning('Information'), 'info');
  assert.equal(levelFromWarning(undefined), 'info');
});

test('NSW facts are parsed from the description and bad rows are dropped', () => {
  assert.equal(
    parseNswDescription('SIZE: 54 ha <br />STATUS: Out of control').STATUS,
    'Out of control',
  );
  const rows = normalizeNswFeed(NSW);
  assert.equal(rows.length, 1, 'a point outside Australia is dropped');
  const [row] = rows;
  assert.equal(row.id, 'nsw:679389');
  assert.equal(row.level, 'watch-act');
  assert.equal(row.sizeHa, 1054);
  assert.equal(row.council, 'Mid-Coast');
  assert.equal(row.status, 'Being controlled');
  assert.deepEqual([row.lat, row.lon], [-32.19, 152.45]);
  assert.equal(row.polygons.length, 1, 'nested fire areas are collected');
  assert.match(row.url, /^https:\/\/www\.rfs\.nsw\.gov\.au\//);
});

test('VIC keeps fire warnings, fire incidents and planned burns only', () => {
  const rows = normalizeVicFeed(VIC);
  assert.deepEqual(
    rows.map((row) => [row.id, row.level]),
    [
      ['vic:warning:43197', 'emergency'],
      ['vic:incident:102737006', 'info'],
      ['vic:incident:3022421', 'planned-burn'],
    ],
  );
  assert.equal(rows[0].status, null, 'CAP severity is not a fire status');
  assert.equal(rows[0].action, 'Leave Now');
  assert.equal(rows[0].polygons.length, 1);
  assert.equal(rows[1].sizeHa, 12.5);
  assert.equal(rows[1].url, 'https://www.ffm.vic.gov.au/x');
  assert.equal(rows[0].updatedMs, Date.parse('2026-09-24T09:08:20+10:00'));
});

test('QLD warnings anchor on their area and fall back to published coordinates', () => {
  const rows = normalizeQldFeed(QLD);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].level, 'advice');
  assert.equal(rows[0].polygons.length, 1);
  assert.equal(rows[0].action, 'Stay Informed');
  assert.equal(rows[1].id, 'qld:3685');
  assert.equal(rows[1].level, 'info');
});

test('the card leads with the warning level and links only to the agency', () => {
  const [row] = normalizeVicFeed(VIC);
  const card = buildAuFireCard(row, Date.parse('2026-09-24T11:08:20+10:00'));
  assert.match(card.title, /^EMERGENCY WARNING · Seacombe$/);
  assert.equal(card.accent, '#e3261c');
  assert.ok(card.details.includes('▶ Leave Now'));
  assert.ok(card.details.some((line) => /updated 2h ago/.test(line)));
  assert.equal(card.interactive, false, 'no url, no click-through');
  assert.equal(isWarningLevel('advice'), true);
  assert.equal(isWarningLevel('info'), false);
});

test('one state failing keeps its last good rows; the others stay live', async () => {
  let clock = 0;
  let vicDown = false;
  const bodies = { nsw: NSW, vic: VIC, qld: QLD };
  const feeds = [
    { state: 'NSW', url: 'nsw', normalize: normalizeNswFeed },
    { state: 'VIC', url: 'vic', normalize: normalizeVicFeed },
    { state: 'QLD', url: 'qld', normalize: normalizeQldFeed },
  ];
  const requested = [];
  const proxy = auFireWarningsProxy({
    now: () => clock,
    feeds,
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === 'vic' && vicDown)
        return { ok: false, status: 503, body: null };
      return new Response(JSON.stringify(bodies[url]));
    },
  });
  const first = await proxy.current();
  assert.equal(first.rows.length, 6);
  assert.ok(first.sources.every((source) => source.ok));

  // Within the cache window nothing is refetched.
  clock = 60_000;
  await proxy.current();
  assert.equal(requested.length, 3);

  vicDown = true;
  clock = 400_000;
  const second = await proxy.current();
  const vic = second.sources.find((source) => source.state === 'VIC');
  assert.deepEqual(
    { ok: vic.ok, stale: vic.stale, count: vic.count },
    { ok: false, stale: true, count: 3 },
  );
  assert.equal(second.rows.length, 6, 'VIC rows are kept, marked delayed');

  // Past the stale limit a dead state drops out instead of lying.
  clock = 400_000 + 7 * 3600_000;
  const third = await proxy.current();
  assert.equal(third.rows.length, 3);
});
