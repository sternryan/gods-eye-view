// src/data/aa5Registry.test.mjs
// The AA-5 adapter over the shared fleet registry (T3 seam). Pure state — no
// viewer or DOM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAa5Icao,
  isAa5LayerActive,
  onAa5LayerActiveChange,
  registerAa5Icaos,
  setAa5LayerActive,
} from './aa5Registry.js';
import {
  isMilitaryIcao,
  isMilitaryLayerActive,
  registerMilitaryIcaos,
  setMilitaryLayerActive,
} from './militaryRegistry.js';

test('AA-5 membership normalizes case and whitespace like the military adapter', () => {
  registerAa5Icaos([' A0B1C2 ', 'D3E4F5']);
  assert.equal(isAa5Icao('a0b1c2'), true);
  assert.equal(isAa5Icao('A0B1C2'), true);
  assert.equal(isAa5Icao('d3e4f5'), true);
  assert.equal(isAa5Icao('ffffff'), false);
  assert.equal(isAa5Icao(''), false);
  assert.equal(isAa5Icao(null), false);
});

test('registration adds only — one poll dropping a hex never declassifies it', () => {
  registerAa5Icaos(['aa1111']);
  registerAa5Icaos(['aa2222']);
  assert.equal(isAa5Icao('aa1111'), true);
  assert.equal(isAa5Icao('aa2222'), true);
  registerAa5Icaos(null);
  assert.equal(isAa5Icao('aa1111'), true);
});

test('the two fleets are separate sets and separate active flags', () => {
  registerAa5Icaos(['ab0001']);
  registerMilitaryIcaos(['ae0001']);
  assert.equal(isAa5Icao('ae0001'), false);
  assert.equal(isMilitaryIcao('ab0001'), false);

  try {
    setAa5LayerActive(true);
    assert.equal(isAa5LayerActive(), true);
    assert.equal(isMilitaryLayerActive(), false);

    setMilitaryLayerActive(true);
    setAa5LayerActive(false);
    assert.equal(isAa5LayerActive(), false);
    assert.equal(isMilitaryLayerActive(), true);
  } finally {
    setAa5LayerActive(false);
    setMilitaryLayerActive(false);
  }
});

test('active-change listeners fire on transitions only, and unsubscribe', () => {
  const seen = [];
  const unsubscribe = onAa5LayerActiveChange((active) => seen.push(active));
  try {
    setAa5LayerActive(false); // already false — no transition
    setAa5LayerActive(true);
    setAa5LayerActive(true); // no transition
    setAa5LayerActive(false);
    assert.deepEqual(seen, [true, false]);

    unsubscribe();
    setAa5LayerActive(true);
    assert.deepEqual(seen, [true, false], 'unsubscribed listeners stop hearing transitions');
  } finally {
    unsubscribe();
    setAa5LayerActive(false);
  }
});
