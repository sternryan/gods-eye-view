/**
 * aa5Aggregator tests — pure-function core of the rotating-subset AA5
 * poll aggregator (T4, 2026-08-30). No fetch/timers/fs here by design;
 * this only locks the data transforms the vite.config.js proxy composes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAa5Allowlist,
  chunkAllowlist,
  mergeAdsbLolBatch,
  activeAa5Aircraft,
  aa5AggregatorState,
} from './aa5Aggregator.js';

test('parseAa5Allowlist normalizes hex case/whitespace and keeps type as-is trimmed', () => {
  const map = parseAa5Allowlist(JSON.stringify([
    { icao24: ' A1B2C3 ', type: 'Traveler' },
    { icao24: 'a4b5c6', type: ' Cheetah ' },
  ]));
  assert.equal(map.size, 2);
  assert.equal(map.get('a1b2c3'), 'Traveler');
  assert.equal(map.get('a4b5c6'), 'Cheetah');
});

test('parseAa5Allowlist skips malformed entries without throwing', () => {
  const map = parseAa5Allowlist(JSON.stringify([
    { icao24: '', type: 'Tiger' },
    { icao24: 'a10001', type: '' },
    { icao24: 'a10002' },
    { type: 'AG-5B' },
    null,
    'not-an-object',
    42,
    { icao24: 'a10003', type: 'AG-5B' },
  ]));
  assert.equal(map.size, 1);
  assert.equal(map.get('a10003'), 'AG-5B');
});

test('parseAa5Allowlist returns an empty Map on invalid JSON or non-array top level, never throws', () => {
  assert.equal(parseAa5Allowlist('not json').size, 0);
  assert.equal(parseAa5Allowlist('{}').size, 0);
  assert.equal(parseAa5Allowlist('{"icao24":"a1","type":"Tiger"}').size, 0);
  assert.equal(parseAa5Allowlist('').size, 0);
});

test('chunkAllowlist splits preserving order, last chunk may be partial', () => {
  const chunks = chunkAllowlist(['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(chunks, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('chunkAllowlist handles empty input and invalid chunkSize', () => {
  assert.deepEqual(chunkAllowlist([], 120), []);
  assert.deepEqual(chunkAllowlist(['a'], 0), []);
  assert.deepEqual(chunkAllowlist(['a'], -5), []);
  assert.deepEqual(chunkAllowlist(['a'], 1.5), []);
});

test('chunkAllowlist accepts a Set (any iterable), not just an array', () => {
  const chunks = chunkAllowlist(new Set(['a', 'b', 'c']), 2);
  assert.deepEqual(chunks, [['a', 'b'], ['c']]);
});

test('mergeAdsbLolBatch upserts only allowlisted hexes, ignores everything else', () => {
  const snapshot = new Map();
  const allowlist = new Map([['a10001', 'Tiger'], ['a10002', 'Cheetah']]);
  mergeAdsbLolBatch(snapshot, allowlist, {
    ac: [
      { hex: 'A10001', lat: 37.5, lon: -122.1, alt_baro: 4500, gs: 110.3, track: 270, flight: ' N123AB ' },
      { hex: 'ffffff', lat: 1, lon: 1 }, // not allowlisted -> ignored
    ],
  }, 1000);
  assert.equal(snapshot.size, 1);
  assert.deepEqual(snapshot.get('a10001'), {
    icao24: 'a10001', type: 'Tiger', lat: 37.5, lon: -122.1,
    altBaroFt: 4500, groundSpeedKt: 110.3, track: 270,
    callsign: 'N123AB', lastSeenMs: 1000,
  });
  assert.equal(snapshot.has('a10002'), false, 'allowlisted but absent from this batch stays absent, not fabricated');
});

test('mergeAdsbLolBatch treats adsb.lol\'s "ground" alt_baro sentinel and other non-numeric fields as null, never throws', () => {
  const snapshot = new Map();
  const allowlist = new Map([['a10001', 'Tiger']]);
  mergeAdsbLolBatch(snapshot, allowlist, {
    ac: [{ hex: 'a10001', lat: undefined, lon: null, alt_baro: 'ground', gs: NaN, track: 'bogus', flight: '   ' }],
  }, 2000);
  const entry = snapshot.get('a10001');
  assert.deepEqual(entry, {
    icao24: 'a10001', type: 'Tiger', lat: null, lon: null,
    altBaroFt: null, groundSpeedKt: null, track: null,
    callsign: null, lastSeenMs: 2000,
  });
});

test('mergeAdsbLolBatch tolerates a missing/non-array ac field without throwing', () => {
  const snapshot = new Map();
  const allowlist = new Map([['a10001', 'Tiger']]);
  assert.doesNotThrow(() => mergeAdsbLolBatch(snapshot, allowlist, {}, 1000));
  assert.doesNotThrow(() => mergeAdsbLolBatch(snapshot, allowlist, { ac: null }, 1000));
  assert.doesNotThrow(() => mergeAdsbLolBatch(snapshot, allowlist, null, 1000));
  assert.equal(snapshot.size, 0);
});

test('mergeAdsbLolBatch overwrites a stale entry with a fresher poll for the same hex', () => {
  const snapshot = new Map();
  const allowlist = new Map([['a10001', 'Tiger']]);
  mergeAdsbLolBatch(snapshot, allowlist, { ac: [{ hex: 'a10001', lat: 1, lon: 1 }] }, 1000);
  mergeAdsbLolBatch(snapshot, allowlist, { ac: [{ hex: 'a10001', lat: 2, lon: 2 }] }, 5000);
  assert.equal(snapshot.get('a10001').lat, 2);
  assert.equal(snapshot.get('a10001').lastSeenMs, 5000);
});

test('activeAa5Aircraft filters by the last-seen window and sorts by icao24', () => {
  const snapshot = new Map([
    ['b20002', { icao24: 'b20002', lastSeenMs: 9000 }],
    ['a10001', { icao24: 'a10001', lastSeenMs: 9500 }],
    ['c30003', { icao24: 'c30003', lastSeenMs: 1000 }], // stale, excluded
  ]);
  const active = activeAa5Aircraft(snapshot, 10000, 5000); // window = 5000ms
  assert.deepEqual(active.map((e) => e.icao24), ['a10001', 'b20002']);
});

test('activeAa5Aircraft excludes entries with a missing/non-finite lastSeenMs', () => {
  const snapshot = new Map([
    ['a10001', { icao24: 'a10001' }], // no lastSeenMs
    ['a10002', { icao24: 'a10002', lastSeenMs: NaN }],
    ['a10003', { icao24: 'a10003', lastSeenMs: 9999 }],
  ]);
  const active = activeAa5Aircraft(snapshot, 10000, 5000);
  assert.deepEqual(active.map((e) => e.icao24), ['a10003']);
});

test('activeAa5Aircraft returns [] for an empty or missing snapshot', () => {
  assert.deepEqual(activeAa5Aircraft(new Map(), 10000, 5000), []);
  assert.deepEqual(activeAa5Aircraft(null, 10000, 5000), []);
});

test('aa5AggregatorState is "loading" before the first full rotation, regardless of poll history', () => {
  assert.equal(aa5AggregatorState({
    hasCompletedFirstRotation: false,
    lastPollSuccessMs: 9999,
    lastPollErrorMs: null,
    nowMs: 10000,
    staleFailureThresholdMs: 60000,
  }), 'loading');
});

test('aa5AggregatorState is "delayed" when no poll has ever succeeded', () => {
  assert.equal(aa5AggregatorState({
    hasCompletedFirstRotation: true,
    lastPollSuccessMs: null,
    lastPollErrorMs: 9000,
    nowMs: 10000,
    staleFailureThresholdMs: 60000,
  }), 'delayed');
});

test('aa5AggregatorState is "delayed" once the last success is older than the stale threshold', () => {
  assert.equal(aa5AggregatorState({
    hasCompletedFirstRotation: true,
    lastPollSuccessMs: 0,
    lastPollErrorMs: null,
    nowMs: 70000,
    staleFailureThresholdMs: 60000,
  }), 'delayed');
});

test('aa5AggregatorState is "ok" once rotated and recently successful', () => {
  assert.equal(aa5AggregatorState({
    hasCompletedFirstRotation: true,
    lastPollSuccessMs: 9000,
    lastPollErrorMs: 9500,
    nowMs: 10000,
    staleFailureThresholdMs: 60000,
  }), 'ok', 'a recent unrelated error must not override a recent success');
});
