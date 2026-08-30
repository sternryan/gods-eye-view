#!/usr/bin/env node
/**
 * T2 STUB — census export mechanism, per the AA5 fleet layer design spec
 * (docs/design/aa5-fleet-layer-spec.md, "Next Steps #2" / "Reviewer Concerns").
 *
 * OPEN ITEM, not resolved by this script: the real allowlist+type data lives
 * in aa5-observatory's D1 (a separate repo not cloned on this machine this
 * session, with no described cross-repo access path). This script writes
 * config/aa5_allowlist.json from a small embedded SAMPLE_FLEET so the T4
 * aggregator has something real to poll against and be tested with — it does
 * NOT pull from aa5-observatory. Replace SAMPLE_FLEET with a real fetch
 * against aa5-observatory's census export (its own icao_allowlist.txt
 * contract, per the spec's Premise 2) once that cross-repo access is
 * designed. Per the spec's own Reviewer Concerns section, this manual-export
 * step still needs a named owner and a re-run cadence before v1 ships for
 * real — this stub does not resolve that either.
 *
 * Usage: node scripts/export-aa5-allowlist.mjs [output-path]
 *   Default output path: config/aa5_allowlist.json (matches T4's
 *   AA5_ALLOWLIST_FILE default, see vite.config.js aa5FlightsProxy()).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sample fleet data — NOT real aa5-observatory census output. Fictional
 * ICAO24 hexes in the unassigned 0xA0xxxx US block, one per AA5 type, so T4
 * has realistic shape (icao24 + type) to poll and test with.
 */
const SAMPLE_FLEET = [
  { icao24: 'a00001', type: 'Traveler' },
  { icao24: 'a00002', type: 'Cheetah' },
  { icao24: 'a00003', type: 'Tiger' },
  { icao24: 'a00004', type: 'AG-5B' },
  { icao24: 'a00005', type: 'Traveler' },
  { icao24: 'a00006', type: 'Tiger' },
];

function main() {
  const outArg = process.argv[2];
  const outPath = outArg
    ? path.resolve(process.cwd(), outArg)
    : path.resolve(__dirname, '..', 'config', 'aa5_allowlist.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(SAMPLE_FLEET, null, 2) + '\n', 'utf8');
  console.log(`[export-aa5-allowlist] wrote ${SAMPLE_FLEET.length} STUB entries to ${outPath}`);
  console.log('[export-aa5-allowlist] this is sample data, not a real aa5-observatory census export — see file header');
}

main();
