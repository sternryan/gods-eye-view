/**
 * @fileoverview Fleet registry management for tracking aircraft ICAO24 hex codes and layer visibility per fleet.
 */

/** @type {string} */
export const MILITARY_FLEET_KEY = 'military';

/** @type {string} */
export const AA5_FLEET_KEY = 'aa5';

/**
 * @typedef {Object} FleetState
 * @property {Set<string>} icaos - Set of lowercase ICAO24 hex strings.
 * @property {boolean} active - Whether the fleet layer is currently enabled.
 * @property {Set<Function>} listeners - Set of callback functions for active state changes.
 * @property {number} lastRefreshMs - Timestamp of the last successful ICAO registration.
 * @property {boolean} refreshing - Flag indicating a fetch operation is currently in flight.
 */

/** @type {Map<string, FleetState>} */
const _registry = new Map();

/**
 * Internal helper to lazily initialize a fleet's state.
 * @param {string} fleetKey 
 * @returns {FleetState}
 */
function _getOrCreateFleet(fleetKey) {
  let state = _registry.get(fleetKey);
  if (!state) {
    state = {
      icaos: new Set(),
      active: false,
      listeners: new Set(),
      lastRefreshMs: 0,
      refreshing: false
    };
    _registry.set(fleetKey, state);
  }
  return state;
}

/**
 * Returns whether the dedicated layer for the given fleet is active.
 * @param {string} fleetKey 
 * @returns {boolean}
 */
export function isFleetLayerActive(fleetKey) {
  const state = _registry.get(fleetKey);
  return state ? state.active : false;
}

/**
 * Sets the active state for a fleet and notifies listeners on transition.
 * @param {string} fleetKey 
 * @param {boolean} active 
 */
export function setFleetLayerActive(fleetKey, active) {
  const state = _getOrCreateFleet(fleetKey);
  const newValue = !!active;

  if (state.active !== newValue) {
    state.active = newValue;
    for (const listener of state.listeners) {
      try {
        listener(state.active);
      } catch (e) {
        // Swallow listener errors to prevent propagation
      }
    }
  }
}

/**
 * Subscribes a listener to active-state transitions for a specific fleet.
 * @param {string} fleetKey 
 * @param {Function} listener 
 * @returns {Function} Unsubscribe function.
 */
export function onFleetLayerActiveChange(fleetKey, listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }

  const state = _getOrCreateFleet(fleetKey);
  state.listeners.add(listener);

  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Adds a set of ICAO24 hex strings to the specified fleet.
 * @param {string} fleetKey 
 * @param {Iterable<string>} icaos 
 */
export function registerFleetIcaos(fleetKey, icaos) {
  if (icaos == null) return;
  const state = _getOrCreateFleet(fleetKey);
  
  for (const icao of icaos) {
    const normalized = String(icao).trim().toLowerCase();
    if (normalized.length > 0) {
      state.icaos.add(normalized);
    }
  }
  state.lastRefreshMs = Date.now();
}

/**
 * Checks if a specific ICAO24 hex string belongs to a fleet.
 * @param {string} fleetKey 
 * @param {string} icao24 
 * @returns {boolean}
 */
export function isFleetIcao(fleetKey, icao24) {
  if (!icao24) return false;
  const state = _registry.get(fleetKey);
  if (!state) return false;
  
  const normalized = String(icao24).trim().toLowerCase();
  return state.icaos.has(normalized);
}

/**
 * Periodically refreshes the fleet's ICAO set from a remote endpoint if stale.
 * @param {string} fleetKey 
 * @param {Object} options
 * @param {string} options.endpoint - URL to fetch data from.
 * @param {number} [options.pollIntervalMs=60000] - Minimum time between refreshes.
 * @param {Function} options.extractIcaos - Function to extract ICAO list from JSON body.
 * @param {Function} [options.isActive] - Optional function to check if fleet is already active.
 * @returns {Promise<void>}
 */
export async function refreshFleetRegistryIfStale(fleetKey, { endpoint, pollIntervalMs = 60000, extractIcaos, isActive }) {
  if (typeof isActive === 'function' && isActive()) {
    return;
  }

  const state = _getOrCreateFleet(fleetKey);
  const now = Date.now();

  if (state.refreshing || (now - state.lastRefreshMs) < pollIntervalMs) {
    return;
  }

  state.refreshing = true;

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const body = await response.json();
      const icaos = extractIcaos(body);
      registerFleetIcaos(fleetKey, icaos);
    }
  } catch (e) {
    // Swallow fetch errors/timeouts
  } finally {
    state.refreshing = false;
  }
}