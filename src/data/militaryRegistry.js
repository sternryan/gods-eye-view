/**
 * Military-fleet adapter over the generalized `fleetRegistry.js` (2026-06-10
 * playtest fix; generalized 2026-08-30 per the AA5 fleet layer design).
 *
 * `fleetRegistry.js` now owns the actual Set<icao24>-by-fleet-key logic so
 * the AA5 layer can reuse it without duplicating membership-check code. This
 * module is a thin, military-flavored adapter that keeps the exact function
 * names and signatures every existing caller (`flights.js`,
 * `militaryFlights.js`) already depends on, so neither needed to change.
 *
 * adsb.lol /v2/mil tags aircraft via its database's military flag; OpenSky
 * carries no such tag, so military aircraft (e.g. ADAPT91/92) appeared in
 * BOTH layers as duplicate icons and tracks. This registry reconciles them:
 *
 *  - The military layer, while enabled, feeds every poll's ICAO set here and
 *    marks itself active — the commercial flights layer then SUPPRESSES its
 *    duplicates (military layer wins icon, track, and click).
 *  - While the military layer is OFF, the flights layer keeps a low-rate
 *    poll (60s against the dev proxy's cached /api/adsblol/mil) so known
 *    military aircraft are still classified and styled amber.
 */

import {
  MILITARY_FLEET_KEY,
  isFleetLayerActive,
  setFleetLayerActive,
  onFleetLayerActiveChange,
  registerFleetIcaos,
  isFleetIcao,
  refreshFleetRegistryIfStale,
} from './fleetRegistry.js';

const MIL_POLL_INTERVAL_MS = 60000;
const MIL_ENDPOINT = '/api/adsblol/mil';
const extractMilIcaos = (data) => {
  const aircraft = Array.isArray(data?.ac) ? data.ac : [];
  return aircraft.map((entry) => entry?.hex);
};

/**
 * True when the dedicated military layer currently renders these aircraft
 * (the flights layer should suppress duplicates rather than restyle them).
 * @returns {boolean}
 */
export function isMilitaryLayerActive() {
  return isFleetLayerActive(MILITARY_FLEET_KEY);
}

/**
 * Marks the dedicated military layer enabled/disabled. On a TRANSITION
 * (value actually changed) the registered change listeners fire so the
 * flights layer can reconcile its duplicates immediately instead of waiting
 * out its 30 s poll (pre-ship audit M2).
 * @param {boolean} active - Whether the military layer renders.
 * @returns {void}
 */
export function setMilitaryLayerActive(active) {
  setFleetLayerActive(MILITARY_FLEET_KEY, active);
}

/**
 * Subscribes to military-layer active-state transitions (fired only when the
 * value changes, AFTER the new state is committed).
 * @param {(active: boolean) => void} listener - Change callback.
 * @returns {() => void} Unsubscribe function.
 */
export function onMilitaryLayerActiveChange(listener) {
  return onFleetLayerActiveChange(MILITARY_FLEET_KEY, listener);
}

/**
 * Replaces/extends the known-military set from a fresh poll.
 * Adds only — transient dropouts from one poll must not declassify an
 * aircraft mid-session (the set stays small: a few hundred hexes).
 * @param {Iterable<string>} icaos - ICAO24 hexes from a /v2/mil response.
 * @returns {void}
 */
export function registerMilitaryIcaos(icaos) {
  registerFleetIcaos(MILITARY_FLEET_KEY, icaos);
}

/**
 * Whether an aircraft is known military.
 * @param {string} icao24 - ICAO24 hex (any case).
 * @returns {boolean}
 */
export function isMilitaryIcao(icao24) {
  return isFleetIcao(MILITARY_FLEET_KEY, icao24);
}

/**
 * Refreshes the registry from /api/adsblol/mil when stale — used by the
 * flights layer so classification works while the military layer is off
 * (the military layer's own polls keep it fresh otherwise). The dev proxy
 * caches upstream responses, so this is nearly free.
 * @returns {void} Fire-and-forget; failures leave the current set intact.
 */
export function refreshMilitaryRegistryIfStale() {
  refreshFleetRegistryIfStale(MILITARY_FLEET_KEY, {
    endpoint: MIL_ENDPOINT,
    pollIntervalMs: MIL_POLL_INTERVAL_MS,
    extractIcaos: extractMilIcaos,
    isActive: isMilitaryLayerActive,
  });
}
