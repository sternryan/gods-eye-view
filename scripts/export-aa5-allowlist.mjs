#!/usr/bin/env node
/**
 * T2 — real census export, per the AA5 fleet layer design spec
 * (docs/design/aa5-fleet-layer-spec.md, "Next Steps #2" / "Reviewer Concerns").
 *
 * Reads the real Grumman AA-5 census from the aa5-observatory repo's SQLite
 * build artifact (data/aa5.db, L0 census — FAA Releasable Aircraft Database
 * ingest, see aa5-observatory/README.md) and emits config/aa5_allowlist.json
 * in the [{icao24, type}] shape T4's aggregator (src/data/aa5Aggregator.js
 * parseAa5Allowlist) expects. Only registered airframes with a non-blank
 * ICAO Mode-S hex are included — deregistered airframes have no live
 * transponder to poll for.
 *
 * This assumes aa5-observatory is checked out as a sibling directory
 * (../aa5-observatory relative to this repo, i.e. /Users/ryanstern/aa5-observatory
 * on Ryan's machine) and its data/aa5.db has been built via `aa5obs build`.
 * This script only reads that DB — it never writes to aa5-observatory.
 *
 * A companion config/aa5_allowlist.meta.json (generatedAt + source + counts)
 * is written alongside the allowlist itself: the aggregator's parser
 * (parseAa5Allowlist) requires the top-level JSON to be a bare array of
 * {icao24, type} objects, so provenance metadata can't be embedded inline
 * without either breaking that contract or being silently dropped by the
 * parser's per-entry validation. Keeping it as a sibling file avoids both.
 *
 * Usage: node scripts/export-aa5-allowlist.mjs [output-path] [--census-db=<path>]
 *   Default output path: config/aa5_allowlist.json (matches T4's
 *   AA5_ALLOWLIST_FILE default, see vite.config.js aa5FlightsProxy()).
 *   Default census DB: ../aa5-observatory/data/aa5.db
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveCensusDbPath(argv) {
  const flag = argv.find((a) => a.startsWith('--census-db='));
  if (flag) return path.resolve(process.cwd(), flag.slice('--census-db='.length));
  return path.resolve(__dirname, '..', '..', 'aa5-observatory', 'data', 'aa5.db');
}

/**
 * Queries the aa5-observatory census DB via the `sqlite3` CLI (read-only,
 * no dependency on a Node sqlite binding). Returns rows of
 * "icao_hex|canonical_type" for every registered airframe with a non-blank
 * ICAO hex.
 */
function queryCensus(dbPath) {
  const sql = `
    SELECT icao_hex, canonical_type
    FROM airframe
    WHERE lifecycle = 'registered'
      AND icao_hex IS NOT NULL
      AND trim(icao_hex) != ''
    ORDER BY icao_hex;
  `;
  const result = spawnSync('sqlite3', ['-readonly', '-separator', '|', dbPath, sql], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `sqlite3 query against ${dbPath} failed (exit ${result.status}): ${result.stderr}`
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hex, type] = line.split('|');
      return { icao24: hex.trim().toLowerCase(), type: (type || '').trim() };
    })
    .filter((e) => e.icao24.length > 0 && e.type.length > 0);
}

function main() {
  const argv = process.argv.slice(2);
  const outArg = argv.find((a) => !a.startsWith('--'));
  const outPath = outArg
    ? path.resolve(process.cwd(), outArg)
    : path.resolve(__dirname, '..', 'config', 'aa5_allowlist.json');
  const metaPath = outPath.replace(/\.json$/, '.meta.json');
  const dbPath = resolveCensusDbPath(argv);

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `aa5-observatory census DB not found at ${dbPath}. Run 'aa5obs fetch && aa5obs build' in aa5-observatory first, or pass --census-db=<path>.`
    );
  }

  const fleet = queryCensus(dbPath);
  const dedupedByHex = new Map(fleet.map((e) => [e.icao24, e.type]));
  const entries = [...dedupedByHex.entries()]
    .map(([icao24, type]) => ({ icao24, type }))
    .sort((a, b) => (a.icao24 < b.icao24 ? -1 : 1));

  const byType = {};
  for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  const meta = {
    generatedAt: new Date().toISOString(),
    source: `aa5-observatory L0 census (${dbPath}), FAA Releasable Aircraft Database ingest — registered airframes with a non-blank ICAO Mode-S hex`,
    sourceRepo: 'aa5-observatory (sibling checkout, not vendored into this repo)',
    entryCount: entries.length,
    byType,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  console.log(`[export-aa5-allowlist] wrote ${entries.length} real AA-5 census entries to ${outPath}`);
  console.log(`[export-aa5-allowlist] by type: ${JSON.stringify(byType)}`);
  console.log(`[export-aa5-allowlist] metadata written to ${metaPath}`);
}

main();
