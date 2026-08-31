// src/data/aa5Flights.test.mjs
// AA-5 fleet layer (T5): pure presentation helpers plus the layer contract
// driven through injected fetch/collection seams, so no WebGL viewer is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AA5_DEFAULT_COLOR,
  AA5_TYPE_COLORS,
  aa5AirborneCount,
  aa5FeedPresentation,
  aa5TypeColorCss,
  createAa5FlightsLayer,
  normalizeAa5Aircraft,
  normalizeAa5Type,
  parseAa5Response,
} from './aa5Flights.js';
import { isAa5Icao, isAa5LayerActive, setAa5LayerActive } from './aa5Registry.js';
import { SPRITE_LAYER_ORDER } from './spriteOrder.js';
import { REGISTERED_LAYER_IDS } from './layerState.js';

function fakeCollection() {
  return {
    show: false,
    items: new Set(),
    add(options) {
      const billboard = { ...options };
      this.items.add(billboard);
      return billboard;
    },
    remove(billboard) {
      this.items.delete(billboard);
    },
  };
}

function fakeViewer() {
  return {
    scene: {
      primitives: {
        add() {}, remove() {}, contains: () => true, raiseToTop() {},
      },
    },
    camera: { moveEnd: { addEventListener: () => () => {} } },
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function aircraft(icao24, overrides = {}) {
  return {
    icao24,
    type: 'Tiger',
    lat: 30.2,
    lon: -97.7,
    altBaroFt: 4500,
    groundSpeedKt: 120,
    track: 90,
    callsign: 'N4543A',
    lastSeenMs: Date.now(),
    ...overrides,
  };
}

/** Build a layer wired to a scripted queue of responses. */
function harness(responses) {
  const queue = [...responses];
  const collection = fakeCollection();
  const calls = [];
  const layer = createAa5FlightsLayer({
    fetchImpl: async (url) => {
      calls.push(url);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    createCollection: () => collection,
  });
  return { layer, collection, calls };
}

test('type colors resolve from model names and FAA type codes alike', () => {
  assert.equal(normalizeAa5Type('AA-5A'), 'CHEETAH');
  assert.equal(normalizeAa5Type(' cheetah '), 'CHEETAH');
  assert.equal(normalizeAa5Type('aa5'), 'TRAVELER');
  assert.equal(normalizeAa5Type('AA-5B'), 'TIGER');
  assert.equal(normalizeAa5Type('ag5b'), 'AG5B');
  assert.equal(normalizeAa5Type(''), '');

  assert.equal(aa5TypeColorCss('Tiger'), AA5_TYPE_COLORS.TIGER);
  assert.equal(aa5TypeColorCss('AA-5'), AA5_TYPE_COLORS.TRAVELER);
  // An unrecognized census string is a data gap, not a reason to drop a live
  // aircraft off the map — it still renders, in the neutral color.
  assert.equal(aa5TypeColorCss('Yankee'), AA5_DEFAULT_COLOR);
  assert.equal(aa5TypeColorCss(null), AA5_DEFAULT_COLOR);
});

test('records without a usable hex or position are dropped, not rendered at 0,0', () => {
  const good = normalizeAa5Aircraft(aircraft('A1B2C3'));
  assert.equal(good.icao24, 'a1b2c3');
  assert.equal(good.altitudeFt, 4500);
  assert.equal(good.colorCss, AA5_TYPE_COLORS.TIGER);

  assert.equal(normalizeAa5Aircraft(aircraft('abc123', { lat: null })), null);
  assert.equal(normalizeAa5Aircraft(aircraft('abc123', { lon: 'x' })), null);
  assert.equal(normalizeAa5Aircraft(aircraft('')), null);
  assert.equal(normalizeAa5Aircraft(null), null);

  // Missing optionals degrade to honest nulls / a north heading, not NaN.
  const sparse = normalizeAa5Aircraft(aircraft('abc123', {
    altBaroFt: null, track: undefined, callsign: '  ',
  }));
  assert.equal(sparse.altitudeFt, null);
  assert.equal(sparse.track, 0);
  assert.equal(sparse.callsign, null);
});

test('response parsing dedupes hexes and fails closed on an unknown state', () => {
  const parsed = parseAa5Response({
    state: 'ok',
    aircraft: [aircraft('a1b2c3'), aircraft('A1B2C3'), aircraft('d4e5f6'), { bogus: true }],
  });
  assert.deepEqual(parsed.records.map((r) => r.icao24), ['a1b2c3', 'd4e5f6']);
  assert.equal(parsed.state, 'ok');

  assert.equal(parseAa5Response({ state: 'loading', aircraft: [] }).state, 'loading');
  assert.equal(parseAa5Response({ state: 'nonsense' }).state, 'delayed');
  assert.equal(parseAa5Response(null).state, 'delayed');
  assert.deepEqual(parseAa5Response(null).records, []);
});

test('the counter is the airborne count with no denominator', () => {
  // Deliberate: 1,888 active-registered vs. 2,760 total is unresolved, so this
  // layer reports the number it can state honestly and omits the ratio.
  assert.equal(aa5AirborneCount([{ icao24: 'a' }, { icao24: 'b' }]), 2);
  assert.equal(aa5AirborneCount([]), 0);
  assert.equal(aa5AirborneCount(null), 0);
});

test('feed state maps to the manager presentation contract', () => {
  assert.deepEqual(aa5FeedPresentation('loading'), { loading: true, error: null });
  assert.deepEqual(aa5FeedPresentation('ok'), { loading: false, error: null });
  assert.deepEqual(
    aa5FeedPresentation('delayed', 'data delayed'),
    { loading: false, error: 'data delayed' },
  );
  // A delayed feed must never read as nominal, even with no message.
  assert.equal(aa5FeedPresentation('delayed', null).error, 'AA-5 data delayed');
});

test('the layer is registered for serialization and sprite ordering', () => {
  assert.ok(REGISTERED_LAYER_IDS.includes('aa5'), 'aa5 has a share-link token');
  assert.ok(SPRITE_LAYER_ORDER.includes('aa5'), 'aa5 has a deterministic sprite slot');
  assert.ok(
    SPRITE_LAYER_ORDER.indexOf('aa5') > SPRITE_LAYER_ORDER.indexOf('military'),
    'the AA-5 fleet draws above the military collection',
  );
});

test('a poll renders the fleet, counts it, and feeds the shared registry', async () => {
  const { layer, collection, calls } = harness([
    jsonResponse({ state: 'ok', aircraft: [aircraft('a1b2c3'), aircraft('d4e5f6', { type: 'Cheetah' })] }),
  ]);
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.equal(collection.show, false, 'a freshly initialized layer is hidden');

  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(calls, ['/api/aa5-flights']);
  assert.equal(collection.items.size, 2);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().loading, false);
  assert.ok(layer.getStats().lastUpdate > 0);
  assert.equal(isAa5Icao('a1b2c3'), true, 'rendered aircraft are claimed in the fleet registry');

  const colors = [...collection.items].map((bb) => bb.color.toCssColorString());
  assert.equal(new Set(colors).size, 2, 'each type gets its own color');

  layer.destroy(viewer);
});

test('a later poll reconciles: departures are removed, survivors are moved', async () => {
  const { layer, collection } = harness([
    jsonResponse({ state: 'ok', aircraft: [aircraft('a1b2c3'), aircraft('d4e5f6')] }),
    jsonResponse({ state: 'ok', aircraft: [aircraft('a1b2c3', { lat: 31.5, lon: -96.0 })] }),
  ]);
  const viewer = fakeViewer();
  layer.init(viewer);
  await layer.update(viewer);
  const [first] = [...collection.items];
  const firstPosition = first.position;

  await layer.update(viewer);
  assert.equal(collection.items.size, 1, 'the aggregator dropped one — so do we');
  assert.equal(layer.getStats().count, 1);
  const survivor = [...collection.items][0];
  assert.equal(survivor, first, 'a survivor keeps its billboard rather than churning');
  assert.notDeepEqual(survivor.position, firstPosition, 'the survivor moved to its new fix');

  layer.destroy(viewer);
});

test('a cold aggregator reads as loading and a stalled one as an error', async () => {
  const { layer } = harness([
    jsonResponse({ state: 'loading', message: 'loading fleet data', aircraft: [] }),
    jsonResponse({ state: 'delayed', message: 'data delayed', aircraft: [] }),
  ]);
  const viewer = fakeViewer();
  layer.init(viewer);

  await layer.update(viewer);
  assert.deepEqual(
    { loading: layer.getStats().loading, error: layer.getStats().error, count: layer.getStats().count },
    { loading: true, error: null, count: 0 },
  );

  await layer.update(viewer);
  assert.equal(layer.getStats().loading, false);
  assert.equal(layer.getStats().error, 'data delayed');

  layer.destroy(viewer);
});

test('a failed poll backs off instead of hammering the aggregator', async () => {
  const { layer, calls } = harness([
    jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    jsonResponse({ state: 'ok', aircraft: [aircraft('a1b2c3')] }),
  ]);
  const viewer = fakeViewer();
  layer.init(viewer);

  assert.equal(await layer.update(viewer), false);
  assert.equal(layer.getStats().error, 'AA5 aggregator HTTP 500');
  assert.equal(await layer.update(viewer), false, 'the retry window is honored');
  assert.equal(calls.length, 1, 'no second request inside the backoff');

  layer.destroy(viewer);
});

test('a network error is reported rather than swallowed into a silently empty map', async () => {
  const { layer } = harness([new Error('offline')]);
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.equal(await layer.update(viewer), false);
  assert.equal(layer.getStats().error, 'AA5 aggregator network error');
  layer.destroy(viewer);
});

test('the toggle shows the collection and claims/releases the fleet', async () => {
  const { layer, collection } = harness([
    jsonResponse({ state: 'ok', aircraft: [aircraft('a1b2c3')] }),
  ]);
  const viewer = fakeViewer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(collection.show, true);
    assert.equal(isAa5LayerActive(), true, 'the flights layer suppresses duplicates while we render');

    layer.disable(viewer);
    assert.equal(collection.show, false);
    assert.equal(isAa5LayerActive(), false, 'turning the layer off releases the claim');

    layer.enable(viewer);
    await layer.update(viewer);
    layer.destroy(viewer);
    assert.equal(isAa5LayerActive(), false, 'destroy releases the claim too');
    assert.equal(layer.getStats().count, 0);
  } finally {
    setAa5LayerActive(false);
  }
});
