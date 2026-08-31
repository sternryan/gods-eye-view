/**
 * AA-5 fleet adapter over the generalized `fleetRegistry.js` (T3), the twin of
 * `militaryRegistry.js`.
 *
 * `fleetRegistry.js` owns the Set<icao24>-by-fleet-key logic; this module is
 * the AA-5-flavored face of it, so callers read `isAa5Icao(hex)` rather than
 * threading a fleet key through every call site.
 *
 * Unlike the military adapter there is no stale-refresh poller here: the AA5
 * layer's own `/api/aa5-flights` poll is the only producer of AA-5 hexes, and
 * the aggregator behind that endpoint already owns the allowlist. Nothing
 * needs the AA-5 set while the layer is off.
 */

import {
  AA5_FLEET_KEY,
  isFleetLayerActive,
  setFleetLayerActive,
  onFleetLayerActiveChange,
  registerFleetIcaos,
  isFleetIcao,
} from './fleetRegistry.js';

/**
 * True when the dedicated AA-5 layer currently renders these aircraft (the
 * commercial flights layer suppresses its duplicates rather than drawing them
 * a second time).
 * @returns {boolean}
 */
export function isAa5LayerActive() {
  return isFleetLayerActive(AA5_FLEET_KEY);
}

/**
 * Marks the dedicated AA-5 layer enabled/disabled. On a TRANSITION (value
 * actually changed) the registered change listeners fire so the flights layer
 * can reconcile duplicates immediately instead of waiting out its poll.
 * @param {boolean} active - Whether the AA-5 layer renders.
 * @returns {void}
 */
export function setAa5LayerActive(active) {
  setFleetLayerActive(AA5_FLEET_KEY, active);
}

/**
 * Subscribes to AA-5-layer active-state transitions (fired only when the value
 * changes, AFTER the new state is committed).
 * @param {(active: boolean) => void} listener - Change callback.
 * @returns {() => void} Unsubscribe function.
 */
export function onAa5LayerActiveChange(listener) {
  return onFleetLayerActiveChange(AA5_FLEET_KEY, listener);
}

/**
 * Extends the known-AA-5 set from a fresh poll. Adds only — a transient
 * dropout from one poll must not declassify an airframe mid-session.
 * @param {Iterable<string>} icaos - ICAO24 hexes from an /api/aa5-flights response.
 * @returns {void}
 */
export function registerAa5Icaos(icaos) {
  registerFleetIcaos(AA5_FLEET_KEY, icaos);
}

/**
 * Whether an aircraft is a known AA-5-series airframe.
 * @param {string} icao24 - ICAO24 hex (any case).
 * @returns {boolean}
 */
export function isAa5Icao(icao24) {
  return isFleetIcao(AA5_FLEET_KEY, icao24);
}
