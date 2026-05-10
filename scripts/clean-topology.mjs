// One-shot topology cleanup for public/data/provinces.geojson.
//
// The source data has each province independently digitized — adjacent
// provinces' shared borders use NEAR-but-not-identical coordinate sets,
// so at deep zoom they project to slightly different pixel paths and
// leave hairline gaps. Mapshaper's `-clean` rebuilds the topology by
// detecting overlapping/coincident segments and sewing them together
// (it adds vertices where adjacent edges meet so both polygons share
// the exact same vertex sequence).
//
// Mapshaper drops a small number of pathological tiny features it can't
// clean. To preserve the array-index `_fid` scheme (snapshots key
// ownerships by index), we splice those originals back in their
// original positions — they keep their imperfect geometry but stay
// addressable.
//
// Run with: node scripts/clean-topology.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../public/data/provinces.geojson');
const BAK = SRC + '.original';
const TMP = '/tmp/provinces.cleaned.geojson';

if (!fs.existsSync(BAK)) {
  fs.copyFileSync(SRC, BAK);
  console.log(`Backed up original -> ${BAK}`);
}

// Always operate on the original so re-runs are deterministic.
fs.copyFileSync(BAK, SRC);

console.log('Running mapshaper -clean...');
execFileSync('npx', [
  'mapshaper', SRC,
  '-clean', 'sliver-control=0', 'gap-fill-area=0',
  '-o', TMP, 'format=geojson',
], { stdio: 'inherit' });

const orig = JSON.parse(fs.readFileSync(BAK, 'utf-8'));
const cleaned = JSON.parse(fs.readFileSync(TMP, 'utf-8'));

// Splice missing originals back in their original positions
const cleanedByCode = new Map(
  cleaned.features.map((f) => [f.properties.adm1_code, f]),
);
const merged = orig.features.map((f) => {
  const c = cleanedByCode.get(f.properties.adm1_code);
  return c ?? f;
});

const reinjected = orig.features.length - cleaned.features.length;
console.log(
  `Cleaned features: ${cleaned.features.length}, ` +
    `re-injected unfixable originals: ${reinjected}, ` +
    `total preserved: ${merged.length}`,
);

const out = { type: 'FeatureCollection', features: merged };
// Pretty-printed for the same reason as state.json — line-based diffs.
fs.writeFileSync(SRC, JSON.stringify(out, null, 2));

// Quick stats
function vertexStats(features) {
  const c = new Map();
  let total = 0;
  for (const f of features) {
    if (!f.geometry) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) for (const pt of ring) {
      total++;
      const k = pt[0].toFixed(6) + ',' + pt[1].toFixed(6);
      c.set(k, (c.get(k) ?? 0) + 1);
    }
  }
  let shared = 0;
  for (const v of c.values()) if (v > 1) shared++;
  return { total, unique: c.size, shared, lone: c.size - shared };
}

console.log('Before:', vertexStats(orig.features));
console.log('After: ', vertexStats(merged));
console.log(`Wrote ${SRC}`);
