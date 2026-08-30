/**
 * fleetRegistry tests — covers both the military and AA5 fleet keys to lock
 * the per-fleet isolation guarantee the AA5 layer depends on (2026-08-30).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MILITARY_FLEET_KEY,
  AA5_FLEET_KEY,
  isFleetLayerActive,
  setFleetLayerActive,
  onFleetLayerActiveChange,
  registerFleetIcaos,
  isFleetIcao,
  refreshFleetRegistryIfStale,
} from './fleetRegistry.js';

test('unknown fleet key returns safe defaults, never throws', () => {
  assert.equal(isFleetLayerActive('unused-fleet'), false);
  assert.equal(isFleetIcao('unused-fleet', 'abc123'), false);
});

test('registerFleetIcaos normalizes case/whitespace and is additive', () => {
  registerFleetIcaos(AA5_FLEET_KEY, [' A1B2C3 ', 'a4b5c6']);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'a1b2c3'), true);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'A1B2C3'), true);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'a4b5c6'), true);

  registerFleetIcaos(AA5_FLEET_KEY, ['a7d8e9']);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'a1b2c3'), true, 'earlier entries survive a later register call');
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'a7d8e9'), true);
});

test('registerFleetIcaos ignores null/undefined and empty/blank entries without throwing', () => {
  assert.doesNotThrow(() => registerFleetIcaos(AA5_FLEET_KEY, null));
  assert.doesNotThrow(() => registerFleetIcaos(AA5_FLEET_KEY, undefined));
  registerFleetIcaos(AA5_FLEET_KEY, ['', '   ', null, undefined]);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, ''), false);
});

test('two fleet keys are fully isolated from each other', () => {
  registerFleetIcaos(MILITARY_FLEET_KEY, ['ffeedd']);
  registerFleetIcaos(AA5_FLEET_KEY, ['112233']);

  assert.equal(isFleetIcao(MILITARY_FLEET_KEY, 'ffeedd'), true);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, 'ffeedd'), false);
  assert.equal(isFleetIcao(AA5_FLEET_KEY, '112233'), true);
  assert.equal(isFleetIcao(MILITARY_FLEET_KEY, '112233'), false);
});

test('setFleetLayerActive fires listeners only on transitions, after state is committed, scoped per fleet key', () => {
  const seenMilitary = [];
  const seenAa5 = [];
  const unsubMil = onFleetLayerActiveChange(MILITARY_FLEET_KEY, (active) => {
    seenMilitary.push({ active, committed: isFleetLayerActive(MILITARY_FLEET_KEY) });
  });
  const unsubAa5 = onFleetLayerActiveChange(AA5_FLEET_KEY, (active) => {
    seenAa5.push({ active });
  });
  try {
    setFleetLayerActive(MILITARY_FLEET_KEY, false); // already false → no fire
    assert.equal(seenMilitary.length, 0);

    setFleetLayerActive(MILITARY_FLEET_KEY, true); // transition → fires military only
    assert.deepEqual(seenMilitary, [{ active: true, committed: true }]);
    assert.equal(seenAa5.length, 0, 'AA5 listener must not fire for a military-key transition');

    setFleetLayerActive(MILITARY_FLEET_KEY, true); // same value → no fire
    assert.equal(seenMilitary.length, 1);

    setFleetLayerActive(AA5_FLEET_KEY, true); // transition → fires AA5 only
    assert.deepEqual(seenAa5, [{ active: true }]);
    assert.equal(seenMilitary.length, 1, 'military listener must not fire for an AA5-key transition');
  } finally {
    unsubMil();
    unsubAa5();
    setFleetLayerActive(MILITARY_FLEET_KEY, false);
    setFleetLayerActive(AA5_FLEET_KEY, false);
  }
});

test('unsubscribe stops delivery; a throwing listener never breaks other listeners or the toggle', () => {
  let calls = 0;
  const unsubBroken = onFleetLayerActiveChange(AA5_FLEET_KEY, () => { throw new Error('boom'); });
  const unsubCounter = onFleetLayerActiveChange(AA5_FLEET_KEY, () => { calls++; });
  try {
    setFleetLayerActive(AA5_FLEET_KEY, true);
    assert.equal(calls, 1);
    assert.equal(isFleetLayerActive(AA5_FLEET_KEY), true);

    unsubCounter();
    setFleetLayerActive(AA5_FLEET_KEY, false);
    assert.equal(calls, 1, 'unsubscribed listener must not be called again');
  } finally {
    unsubBroken();
    unsubCounter();
    setFleetLayerActive(AA5_FLEET_KEY, false);
  }
});

test('onFleetLayerActiveChange tolerates a non-function listener without throwing', () => {
  const unsub = onFleetLayerActiveChange(AA5_FLEET_KEY, null);
  assert.equal(typeof unsub, 'function');
  assert.doesNotThrow(() => unsub());
  setFleetLayerActive(AA5_FLEET_KEY, true);
  assert.equal(isFleetLayerActive(AA5_FLEET_KEY), true);
  setFleetLayerActive(AA5_FLEET_KEY, false);
});

test('refreshFleetRegistryIfStale skips the fetch entirely when isActive() reports true', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    await refreshFleetRegistryIfStale('spy-fleet-active', {
      endpoint: '/api/spy-fleet',
      extractIcaos: () => [],
      isActive: () => true,
    });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshFleetRegistryIfStale fetches, extracts, and registers icaos on a fresh (never-refreshed) fleet', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = null;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ ac: [{ hex: 'DEAD01' }, { hex: 'BEEF02' }] }) };
  };
  try {
    await refreshFleetRegistryIfStale('spy-fleet-fresh', {
      endpoint: '/api/spy-fleet',
      pollIntervalMs: 60000,
      extractIcaos: (body) => (body.ac || []).map((a) => a.hex),
    });
    assert.equal(requestedUrl, '/api/spy-fleet');
    assert.equal(isFleetIcao('spy-fleet-fresh', 'dead01'), true);
    assert.equal(isFleetIcao('spy-fleet-fresh', 'beef02'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshFleetRegistryIfStale skips the fetch when the fleet was refreshed within pollIntervalMs', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ ac: [{ hex: 'aa0001' }] }) }; };
  try {
    await refreshFleetRegistryIfStale('spy-fleet-cooldown', {
      endpoint: '/api/spy-fleet',
      pollIntervalMs: 60000,
      extractIcaos: (body) => (body.ac || []).map((a) => a.hex),
    });
    assert.equal(calls, 1);

    await refreshFleetRegistryIfStale('spy-fleet-cooldown', {
      endpoint: '/api/spy-fleet',
      pollIntervalMs: 60000,
      extractIcaos: (body) => (body.ac || []).map((a) => a.hex),
    });
    assert.equal(calls, 1, 'still within pollIntervalMs → no second fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshFleetRegistryIfStale on a failed fetch leaves the existing set untouched and never throws', async () => {
  const originalFetch = globalThis.fetch;
  registerFleetIcaos('spy-fleet-failure', ['ff0001']);
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    await assert.doesNotReject(refreshFleetRegistryIfStale('spy-fleet-failure', {
      endpoint: '/api/spy-fleet',
      pollIntervalMs: 0,
      extractIcaos: () => ['aa9999'],
    }));
    assert.equal(isFleetIcao('spy-fleet-failure', 'ff0001'), true, 'existing entry survives a failed refresh');
    assert.equal(isFleetIcao('spy-fleet-failure', 'aa9999'), false, 'a failed fetch must not register new icaos');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
