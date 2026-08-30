/**
 * @file aa5Aggregator.js
 * Pure data-transformation logic for a rotating-subset ADS-B poll aggregator.
 */

/**
 * Parses a JSON string into a Map of allowlisted ICAO24 hexes to types.
 * @param {string} rawJsonText - The raw JSON string.
 * @returns {Map<string, string>}
 */
export function parseAa5Allowlist(rawJsonText) {
  try {
    const parsed = JSON.parse(rawJsonText);
    if (!Array.isArray(parsed)) return new Map();

    const map = new Map();
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof entry.icao24 === 'string' && typeof entry.type === 'string') {
        const hex = entry.icao24.trim().toLowerCase();
        const type = entry.type.trim();
        if (hex.length > 0 && type.length > 0) {
          map.set(hex, type);
        }
      }
    }
    return map;
  } catch (e) {
    return new Map();
  }
}

/**
 * Chunks an iterable of ICAO24 hex strings into arrays of a specific size.
 * @param {Iterable<string>} icao24List
 * @param {number} chunkSize
 * @returns {string[][]}
 */
export function chunkAllowlist(icao24List, chunkSize) {
  if (chunkSize <= 0 || !Number.isInteger(chunkSize)) return [];
  
  const chunks = [];
  let currentChunk = [];
  
  for (const item of icao24List) {
    currentChunk.push(item);
    if (currentChunk.length === chunkSize) {
      chunks.push(currentChunk);
      currentChunk = [];
    }
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

/**
 * Mutates the snapshot Map with data from an adsb.lol response.
 * @param {Map<string, object>} snapshot
 * @param {Map<string, string>} allowlist
 * @param {object} adsbLolResponseBody
 * @param {number} nowMs
 */
export function mergeAdsbLolBatch(snapshot, allowlist, adsbLolResponseBody, nowMs) {
  if (!adsbLolResponseBody || !Array.isArray(adsbLolResponseBody.ac)) {
    return;
  }

  const toFiniteOrNull = (val) => {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : null;
  };

  const toTrimmedStringOrNull = (val) => {
    if (typeof val !== 'string') return null;
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  for (const ac of adsbLolResponseBody.ac) {
    if (!ac || typeof ac.hex !== 'string') continue;

    const hex = ac.hex.trim().toLowerCase();
    const type = allowlist.get(hex);

    if (type === undefined) continue;

    snapshot.set(hex, {
      icao24: hex,
      type: type,
      lat: toFiniteOrNull(ac.lat),
      lon: toFiniteOrNull(ac.lon),
      altBaroFt: toFiniteOrNull(ac.alt_baro),
      groundSpeedKt: toFiniteOrNull(ac.gs),
      track: toFiniteOrNull(ac.track),
      callsign: toTrimmedStringOrNull(ac.flight),
      lastSeenMs: nowMs
    });
  }
}

/**
 * Returns an array of active aircraft values from the snapshot.
 * @param {Map<string, object>} snapshot
 * @param {number} nowMs
 * @param {number} lastSeenWindowMs
 * @returns {object[]}
 */
export function activeAa5Aircraft(snapshot, nowMs, lastSeenWindowMs) {
  if (!snapshot || snapshot.size === 0) return [];

  const active = [];
  for (const entry of snapshot.values()) {
    if (typeof entry.lastSeenMs === 'number' && Number.isFinite(entry.lastSeenMs)) {
      if ((nowMs - entry.lastSeenMs) <= lastSeenWindowMs) {
        active.push(entry);
      }
    }
  }

  return active.sort((a, b) => (a.icao24 < b.icao24 ? -1 : 1));
}

/**
 * Determines the current operational state of the aggregator.
 * @param {object} params
 * @param {boolean} params.hasCompletedFirstRotation
 * @param {number} params.lastPollSuccessMs
 * @param {number} params.lastPollErrorMs
 * @param {number} params.nowMs
 * @param {number} params.staleFailureThresholdMs
 * @returns {'loading' | 'delayed' | 'ok'}
 */
export function aa5AggregatorState({ 
  hasCompletedFirstRotation, 
  lastPollSuccessMs, 
  lastPollErrorMs, 
  nowMs, 
  staleFailureThresholdMs 
}) {
  if (!hasCompletedFirstRotation) {
    return 'loading';
  }

  if (!Number.isFinite(lastPollSuccessMs) || (nowMs - lastPollSuccessMs) > staleFailureThresholdMs) {
    return 'delayed';
  }

  return 'ok';
}