import * as Cesium from 'cesium';
import { aircraftIcon } from './aircraftIcons.js';
import { CLASS_SCALE_2D } from './aircraftClass.js';
import { screenProjectedRotation, stabilizeScreenRotation } from './iconOrientation.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  unregisterSpriteCollection,
} from './spriteOrder.js';
import { registerAa5Icaos, setAa5LayerActive } from './aa5Registry.js';

/**
 * @module aa5Flights
 * @description Grumman AA-5-series fleet layer (T5, AA-5 Fleet Layer design).
 *
 * The nationwide AA-5 census is polled server-side by the `/api/aa5-flights`
 * aggregator (T4, `vite.config.js` + `aa5Aggregator.js`), which rotates
 * through the allowlist in adsb.lol-sized batches and returns only aircraft
 * seen inside its last-seen window. This layer is the client half: it renders
 * that snapshot, feeds the shared fleet registry (T3, `aa5Registry.js`) so the
 * commercial flights layer can suppress its duplicates, and reports the
 * airborne count to the layer panel.
 *
 * Deliberately NOT a copy of `militaryFlights.js`. Click-to-track, glTF
 * models, trails, dead reckoning, and cockpit contacts are all military-layer
 * features that v1 of this layer does not have; what IS shared comes from the
 * modules both layers import — `aircraftIcons`, `aircraftClass`,
 * `iconOrientation`, `spriteOrder`, `pickRegistry` — rather than from a fork
 * of that file. The layer is a plain billboard collection reconciled once per
 * poll, which is the right size for a fleet whose realistic
 * airborne-at-once count is low dozens.
 */

/** @constant {string} Dev-proxy endpoint served by the AA5 aggregator (T4). */
const API_URL = '/api/aa5-flights';

/** Poll cadence — matches the aggregator's 20 s shared response cache, so a
 *  faster client poll could only re-read the same bytes. */
const UPDATE_INTERVAL_MS = 20000;

/** Cooldown after a failed poll, mirroring militaryFlights' transient backoff. */
const ERROR_BACKOFF_MS = 20000;

/** Every AA-5 variant is a light single — one silhouette, one class scale. */
const AA5_CLASS = 'light';

/** Fleet glyph scale (mirror of militaryFlights' BILLBOARD_SCALE). */
const BILLBOARD_SCALE = 0.7;

/** Sprite-order / pick-ownership key. Must match the manager layer id. */
export const AA5_LAYER_ID = 'aa5';

/**
 * Type-colored fleet: the four AA-5-series models the census tracks. Keys are
 * the normalized form produced by {@link normalizeAa5Type}, so both the model
 * name ("Cheetah") and the FAA type code ("AA5A") resolve to one color.
 */
export const AA5_TYPE_COLORS = Object.freeze({
  TRAVELER: '#6FD3FF',
  CHEETAH: '#79F2A8',
  TIGER: '#FFB454',
  AG5B: '#FF8AD8',
});

/** Color for an allowlist entry whose type string is unrecognized. */
export const AA5_DEFAULT_COLOR = '#C9D6E2';

/** FAA/ADS-B type codes onto the model names the palette is keyed by. */
const AA5_TYPE_ALIASES = Object.freeze({
  AA5: 'TRAVELER',
  AA5A: 'CHEETAH',
  AA5B: 'TIGER',
  AG5B: 'AG5B',
});

/**
 * Normalize a census/allowlist type string to a palette key. Case, spaces, and
 * hyphens vary between the census export and adsb.lol ("AA-5B", "aa5b",
 * "Tiger"), so all three collapse to one key.
 * @param {string} type - Raw type text from the aggregator.
 * @returns {string} Normalized key, or '' when the input carries no type.
 */
export function normalizeAa5Type(type) {
  const key = String(type ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key) return '';
  return AA5_TYPE_ALIASES[key] || key;
}

/**
 * Per-type fleet color. Unknown types still render — in the neutral color —
 * because an unrecognized census string is a data gap, not a reason to drop a
 * live aircraft off the map.
 * @param {string} type - Raw type text from the aggregator.
 * @returns {string} CSS color.
 */
export function aa5TypeColorCss(type) {
  return AA5_TYPE_COLORS[normalizeAa5Type(type)] || AA5_DEFAULT_COLOR;
}

/**
 * Normalize one aggregator aircraft record into the fields this layer renders.
 * Records without a usable hex or position are dropped: a billboard needs both,
 * and the aggregator can hold an entry whose last batch carried no position.
 * @param {object|null|undefined} entry - One element of the `aircraft` array.
 * @returns {{icao24: string, type: string, lat: number, lon: number,
 *   altitudeFt: number|null, track: number, callsign: string|null,
 *   colorCss: string}|null} Render record, or null when unusable.
 */
export function normalizeAa5Aircraft(entry) {
  // The aggregator writes null for a field its last batch did not carry, and
  // Number(null) is 0 — a null latitude must never become the equator.
  const num = (value) => (value == null || value === '' ? NaN : Number(value));
  const icao24 = String(entry?.icao24 ?? '').trim().toLowerCase();
  const lat = num(entry?.lat);
  const lon = num(entry?.lon);
  if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const altitudeFt = num(entry?.altBaroFt);
  const track = num(entry?.track);
  const callsign = String(entry?.callsign ?? '').trim();
  const type = String(entry?.type ?? '').trim();
  return {
    icao24,
    type,
    lat,
    lon,
    altitudeFt: Number.isFinite(altitudeFt) ? altitudeFt : null,
    track: Number.isFinite(track) ? track : 0,
    callsign: callsign || null,
    colorCss: aa5TypeColorCss(type),
  };
}

/**
 * Parse an `/api/aa5-flights` body into render records plus the feed state.
 * @param {object|null|undefined} body - Decoded JSON response.
 * @returns {{records: object[], state: string, message: string|null}}
 */
export function parseAa5Response(body) {
  const rawState = String(body?.state ?? '').trim().toLowerCase();
  const state = ['loading', 'delayed', 'ok'].includes(rawState) ? rawState : 'delayed';
  const rows = Array.isArray(body?.aircraft) ? body.aircraft : [];
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    const record = normalizeAa5Aircraft(row);
    if (!record || seen.has(record.icao24)) continue;
    seen.add(record.icao24);
    records.push(record);
  }
  const message = typeof body?.message === 'string' && body.message.trim()
    ? body.message.trim()
    : null;
  return { records, state, message };
}

/**
 * The layer-panel counter for this layer.
 *
 * Airborne count ONLY — no "N of M" denominator. The census offers two
 * candidate denominators (1,888 active-registered vs. 2,760 including
 * deregistered) and which one an owner should read has not been settled, so
 * this v1 shows the number it can state honestly and omits the ratio rather
 * than picking a denominator by default. Restore the ratio here once the
 * question is answered, not before.
 * @param {object[]} records - Normalized render records.
 * @returns {number} Aircraft currently rendered.
 */
export function aa5AirborneCount(records) {
  return Array.isArray(records) ? records.length : 0;
}

/**
 * Map the aggregator's feed state to the layer-stats presentation contract
 * (`manager.js#layerFeedState`): 'loading' surfaces the cold-cache state,
 * 'delayed' surfaces a sustained source failure as an honest error rather than
 * a silently stale map.
 * @param {string} state - Aggregator state.
 * @param {string|null} message - Aggregator-supplied message.
 * @returns {{loading: boolean, error: string|null}}
 */
export function aa5FeedPresentation(state, message = null) {
  if (state === 'loading') return { loading: true, error: null };
  if (state === 'delayed') return { loading: false, error: message || 'AA-5 data delayed' };
  return { loading: false, error: null };
}

/**
 * Build the AA-5 fleet layer.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Fetch seam (tests inject a stub).
 * @param {Function} [options.createCollection] - Billboard-collection factory
 *   (tests inject a plain object so no WebGL viewer is needed).
 * @returns {object} Layer module conforming to the data-manager contract.
 */
export function createAa5FlightsLayer({
  fetchImpl = null,
  createCollection = () => new Cesium.BillboardCollection(),
} = {}) {
  /** @type {object|null} */
  let _collection = null;
  /** @type {Map<string, object>} icao24 -> billboard */
  const _billboards = new Map();
  /** @type {Map<string, object>} icao24 -> last normalized record */
  const _records = new Map();
  /** @type {(() => void)|null} */
  let _moveEndRemove = null;
  let _viewer = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _loading = false;
  let _retryAt = 0;

  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  /** Screen-projected rotation pass — the same orientation machinery the
   *  military and commercial layers use, run per poll and per settled camera
   *  move instead of per frame (a low-dozens fleet needs no frame animator). */
  function _applyRotations() {
    const scene = _viewer?.scene;
    if (!scene) return;
    for (const [icao24, bb] of _billboards) {
      const record = _records.get(icao24);
      if (!record) continue;
      const next = screenProjectedRotation(scene, bb.position, record.track, bb.rotation);
      if (Number.isFinite(next)) {
        bb.rotation = stabilizeScreenRotation(bb.rotation, next);
      }
    }
  }

  function _positionFor(record) {
    const altitudeM = record.altitudeFt === null ? 0 : record.altitudeFt * 0.3048;
    return Cesium.Cartesian3.fromDegrees(record.lon, record.lat, altitudeM);
  }

  /** Reconcile the billboard collection against one poll's records. */
  function _render(records) {
    if (!_collection) return;
    const present = new Set();

    for (const record of records) {
      present.add(record.icao24);
      _records.set(record.icao24, record);
      const position = _positionFor(record);
      const color = Cesium.Color.fromCssColorString(record.colorCss);
      const existing = _billboards.get(record.icao24);
      if (existing) {
        existing.position = position;
        existing.color = color;
        continue;
      }
      _billboards.set(record.icao24, _collection.add({
        position,
        image: aircraftIcon(AA5_CLASS),
        width: 20,
        height: 20,
        scale: BILLBOARD_SCALE * (CLASS_SCALE_2D[AA5_CLASS] || 1),
        rotation: 0,
        alignedAxis: Cesium.Cartesian3.ZERO,
        color,
        sizeInMeters: false,
        scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
        // Uniform always-visible depth policy, matching every other contact
        // layer — a low-and-slow AA-5 would otherwise sink into photoreal tiles.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: record.icao24,
      }));
    }

    // The aggregator already applies the 5-minute last-seen window, so an
    // absence here means the fleet's own freshness rule dropped the aircraft —
    // no second grace period on this side.
    for (const [icao24, bb] of _billboards) {
      if (present.has(icao24)) continue;
      _collection.remove(bb);
      _billboards.delete(icao24);
      _records.delete(icao24);
    }

    _count = aa5AirborneCount(records);
    _applyRotations();
  }

  function _clearRendered() {
    if (_collection) {
      for (const bb of _billboards.values()) _collection.remove(bb);
    }
    _billboards.clear();
    _records.clear();
    _count = 0;
  }

  const layer = {
    id: AA5_LAYER_ID,
    name: 'AA-5 Fleet',
    icon: '🛩️',
    source: 'adsb.lol',
    updateInterval: UPDATE_INTERVAL_MS,

    /**
     * Create the billboard collection and reset state.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    init(viewer) {
      _viewer = viewer;
      _collection = createCollection();
      _collection.show = false;
      viewer?.scene?.primitives?.add(_collection);
      registerSpriteCollection(AA5_LAYER_ID, _collection);
      _billboards.clear();
      _records.clear();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _loading = false;
      _retryAt = 0;
      console.log('[Data:AA5] Initialized');
    },

    /**
     * Show the layer and claim the fleet in the shared registry.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_collection) _collection.show = true;
      registerPickOwner(AA5_LAYER_ID, (pickedId) => _billboards.has(pickedId));
      // The commercial flights layer suppresses its civil duplicates while we
      // render these aircraft (same contract the military layer uses).
      setAa5LayerActive(true);
      if (!_moveEndRemove && _viewer?.camera?.moveEnd) {
        _moveEndRemove = _viewer.camera.moveEnd.addEventListener(_applyRotations);
      }
      restoreSpriteOrder(_viewer);
    },

    /**
     * Hide the layer and release the fleet claim.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    disable(viewer) {
      _viewer = viewer || _viewer;
      if (_collection) _collection.show = false;
      unregisterPickOwner(AA5_LAYER_ID);
      setAa5LayerActive(false);
      if (_moveEndRemove) {
        _moveEndRemove();
        _moveEndRemove = null;
      }
    },

    /**
     * Poll the aggregator and reconcile the rendered fleet.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     * @returns {Promise<boolean>} Whether the poll produced a usable snapshot.
     */
    async update(viewer) {
      _viewer = viewer || _viewer;
      const nowMs = Date.now();
      if (_retryAt && nowMs < _retryAt) return false;

      try {
        const response = await doFetch(API_URL);
        if (!response?.ok) {
          _retryAt = nowMs + ERROR_BACKOFF_MS;
          _loading = false;
          _lastError = `AA5 aggregator HTTP ${response?.status ?? 'error'}`;
          return false;
        }
        const body = await response.json();
        const { records, state, message } = parseAa5Response(body);
        const presentation = aa5FeedPresentation(state, message);
        _loading = presentation.loading;
        _lastError = presentation.error;
        _retryAt = 0;

        _render(records);
        // Feed the shared registry so the flights layer can classify and
        // suppress the civil duplicates of aircraft we are drawing.
        registerAa5Icaos(records.map((record) => record.icao24));
        _lastUpdate = Date.now();
        console.log(`[Data:AA5] Updated: ${_count} airborne`);
        return true;
      } catch (error) {
        _retryAt = Date.now() + ERROR_BACKOFF_MS;
        _loading = false;
        _lastError = 'AA5 aggregator network error';
        console.warn('[Data:AA5] Fetch error:', error);
        return false;
      }
    },

    /**
     * Tear the layer down completely.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    destroy(viewer) {
      this.disable(viewer);
      _clearRendered();
      unregisterSpriteCollection(AA5_LAYER_ID, _collection);
      if (_collection) {
        (viewer || _viewer)?.scene?.primitives?.remove(_collection);
        _collection = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _loading = false;
      _retryAt = 0;
    },

    /**
     * Layer health for the toggle panel's count + status chip.
     * @returns {{count: number, lastUpdate: number|null, error: string|null,
     *   loading: boolean, source: string, fallback: boolean}}
     */
    getStats() {
      return {
        // Airborne count only — see aa5AirborneCount for why there is no
        // denominator here.
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        loading: _loading,
        source: 'adsb.lol',
        fallback: false,
      };
    },
  };

  return layer;
}

const aa5FlightsLayer = createAa5FlightsLayer();

export default aa5FlightsLayer;
