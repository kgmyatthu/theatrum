// One-shot baker for the 1800 population figure shown on each province.
//
// Writes public/data/population1800.json — a flat  adm1_code -> integer  map:
//
//   { "GBR-2054": 122323, "ESP-5846": 216557, ... }
//
// Why flat and why baked: the client renders a hover card per province and
// already holds properties.adm1_code, so a single property lookup is the whole
// join. Anything richer (nested objects, per-year series, a features array)
// would force the client to do work at paint time that this script can do once,
// offline, and it would balloon a ~75 KB payload that every visitor downloads.
// bake-state.mjs is the precedent: heavyweight source data in, committed JSON
// out, no runtime dependency on the source.
//
// SOURCE: HYDE 3.2.1, AD 1800, 5-arcmin global rasters (Klein Goldewijk et al.).
//   popc_1800AD.asc  population COUNT per cell   — the number we sum
//   popd_1800AD.asc  population DENSITY per km2  — only used to rescue provinces
//                                                  smaller than one cell
//   popc_c.txt       per-country control totals  — validation only, never summed
//                                                  into the output
//
// Run with:
//   node scripts/bake-population.mjs <inputDir>
//
// inputDir is the directory the three HYDE files were downloaded into, and it is
// REQUIRED rather than defaulted: the rasters are ~79 MB apiece and deliberately
// NOT committed, so there is no in-repo location to point at, and any default
// would be one machine's scratch directory baked into everyone else's checkout.
// The script stays re-runnable by anyone who re-downloads HYDE; nobody pays for
// the rasters in the repo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../public/data');
const GEOJSON = path.join(DATA, 'provinces.geojson');
const OUT = path.join(DATA, 'population1800.json');

const IN_DIR = process.argv[2];
if (!IN_DIR) {
  console.error(
    'usage: node scripts/bake-population.mjs <inputDir>\n' +
      '  <inputDir> must contain popc_1800AD.asc, popd_1800AD.asc and popc_c.txt\n' +
      '  from HYDE 3.2.1 (not committed — ~79 MB apiece).',
  );
  process.exit(1);
}
const POPC = path.join(IN_DIR, 'popc_1800AD.asc');
const POPD = path.join(IN_DIR, 'popd_1800AD.asc');
const POPC_C = path.join(IN_DIR, 'popc_c.txt');

// Expectations from prior research. These are printed next to the computed
// figures so a re-run that drifts is obvious. They are NEVER used to correct or
// scale the output — if a number disagrees the report says so and the data
// stands as computed.
const EXPECT = {
  rasterTotal: 943_431_063,
  controlTotal: 943_430_613,
  orphanCells: 18_018,
  orphanPeople: 12_987_571,
  zerosNaive: 520,
  popdRescued: 254,
  leicestershire: 122_000, // 1801 census: 130,081
  // Sanity figures are COUNTRY totals, so they are checked against
  // modern_country, not against the 1680-era `owner` column.
  countries: {
    France: 27_700_000,
    'United Kingdom': 11_400_000,
    Spain: 11_300_000,
    'United States of America': 6_200_000,
    China: 290_000_000,
  },
};

const NCOLS = 4320;
const NROWS = 2160;
// The header says cellsize 0.0833333, which is TRUNCATED: 4320 * 0.0833333 is
// 359.99986 degrees, not 360. Using the header value accumulates error westward
// to eastward and puts cell centres ~1.4 arcmin out of place at the
// antimeridian — enough to drop Kamchatkan and New Zealand cells into the wrong
// province. The grid is definitionally global, so derive the true cell size.
const CELL = 360 / NCOLS;
const D2R = Math.PI / 180;
const R_EARTH_KM = 6371.0087714; // IUGG mean radius

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b === 0 ? '0.00' : ((a / b) * 100).toFixed(2));

// ---------------------------------------------------------------------------
// 1. Raster parsing
// ---------------------------------------------------------------------------

// ESRI ASCII grid: 6 "key value" header lines, then nrows lines of ncols
// whitespace-separated floats, row 0 at the NORTH edge.
//
// 79 MB of text is 9.3M tokens. String.prototype.split on the whole file would
// materialise 9.3M JS strings at once (>1 GB retained) before a single number is
// parsed. Instead we scan the Buffer byte-wise and only materialise a string for
// tokens we actually have to parse:
//   - a leading '-' can only be NODATA (-9999.0); counts and densities are never
//     negative, so we skip the parse entirely
//   - "0.0" is by far the commonest real token on land, so it gets its own
//     3-byte fast path
// That leaves ~1.5M genuine parses out of 9.3M tokens.
//
// NODATA lands in the array as NaN rather than 0 so step 5 can tell "ocean /
// no land mask" apart from "land with nobody on it". Every comparison we do is
// `> 0`, which is false for NaN, so NaN is inert everywhere else.
function readAsc(file, label) {
  const t0 = Date.now();
  const buf = fs.readFileSync(file);

  let headerEnd = 0;
  for (let lines = 0; lines < 6 && headerEnd < buf.length; headerEnd++) {
    if (buf[headerEnd] === 10) lines++;
  }
  const header = buf.toString('latin1', 0, headerEnd);
  const hdr = Object.fromEntries(
    header
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .map(([k, v]) => [k.toLowerCase(), Number(v)]),
  );
  if (hdr.ncols !== NCOLS || hdr.nrows !== NROWS) {
    throw new Error(`${label}: expected ${NCOLS}x${NROWS}, got ${hdr.ncols}x${hdr.nrows}`);
  }

  const grid = new Float32Array(NCOLS * NROWS);
  const len = buf.length;
  let i = headerEnd;
  let n = 0;
  while (i < len) {
    while (i < len && buf[i] <= 32) i++; // whitespace: space, \r, \n
    if (i >= len) break;
    const start = i;
    while (i < len && buf[i] > 32) i++;
    if (buf[start] === 45 /* '-' */) {
      grid[n++] = NaN; // NODATA
    } else if (i - start === 3 && buf[start] === 48 /* "0.0" */) {
      grid[n++] = 0;
    } else {
      grid[n++] = +buf.toString('latin1', start, i);
    }
  }
  if (n !== grid.length) {
    throw new Error(`${label}: expected ${grid.length} cells, parsed ${n}`);
  }
  console.log(`  parsed ${label}: ${fmt(n)} cells in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return grid;
}

// ---------------------------------------------------------------------------
// 2. Province geometry
// ---------------------------------------------------------------------------

// Flatten every feature to its constituent polygons. A MultiPolygon province
// (an archipelago, or a mainland plus its enclaves) becomes several entries that
// all credit the same adm1_code. Rings are stored as flat Float64Arrays
// [x0,y0,x1,y1,...]: the inner loop of a ray cast runs 1.5M times, and indexing
// a flat typed array beats chasing 288k two-element sub-arrays.
function loadPolygons() {
  const gj = JSON.parse(fs.readFileSync(GEOJSON, 'utf-8'));
  const features = gj.features;
  const codes = features.map((f) => f.properties.adm1_code);

  const P = {
    feature: [], // index into features[]
    outer: [], // Float64Array
    holes: [], // Float64Array[]
    box: [], // [minX, minY, maxX, maxY]
    cx: [],
    cy: [],
    areaKm2: [],
  };

  for (let fi = 0; fi < features.length; fi++) {
    const g = features[fi].geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of polys) {
      const outer = flatten(rings[0]);
      const holes = rings.slice(1).map(flatten);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < outer.length; k += 2) {
        if (outer[k] < minX) minX = outer[k];
        if (outer[k] > maxX) maxX = outer[k];
        if (outer[k + 1] < minY) minY = outer[k + 1];
        if (outer[k + 1] > maxY) maxY = outer[k + 1];
      }
      let area = ringAreaKm2(outer);
      for (const h of holes) area -= ringAreaKm2(h);
      const c = ringCentroid(outer, minX, minY, maxX, maxY);
      P.feature.push(fi);
      P.outer.push(outer);
      P.holes.push(holes);
      P.box.push([minX, minY, maxX, maxY]);
      P.cx.push(c[0]);
      P.cy.push(c[1]);
      P.areaKm2.push(Math.max(area, 0));
    }
  }
  return { features, codes, P };
}

function flatten(ring) {
  const a = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    a[i * 2] = ring[i][0];
    a[i * 2 + 1] = ring[i][1];
  }
  return a;
}

// Standard even-odd ray cast, horizontal ray to -infinity. Boundary cases are
// left to fall where the float comparison puts them: a cell centre landing
// exactly on a shared border is a measure-zero event on a 5-arcmin grid, and
// either neighbour is an equally defensible answer.
function inRing(r, x, y) {
  let inside = false;
  const len = r.length;
  for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
    const yi = r[i + 1];
    const yj = r[j + 1];
    if (yi > y !== yj > y) {
      const xi = r[i];
      if (x < ((r[j] - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Spherical excess via the standard line integral, exact for a polygon of any
// size on a sphere. Only used for sub-cell provinces in practice, where a
// planar approximation would also have done — but this costs the same 6 lines
// and does not need a "valid below N km2" caveat attached to it.
function ringAreaKm2(r) {
  let s = 0;
  const len = r.length;
  for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
    s += (r[i] - r[j]) * D2R * (2 + Math.sin(r[j + 1] * D2R) + Math.sin(r[i + 1] * D2R));
  }
  return Math.abs((s * R_EARTH_KM * R_EARTH_KM) / 2);
}

// Shoelace centroid, falling back to the bbox centre for degenerate rings
// (a handful of provinces are collapsed slivers with ~zero signed area).
function ringCentroid(r, minX, minY, maxX, maxY) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const len = r.length;
  for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
    const cross = r[j] * r[i + 1] - r[i] * r[j + 1];
    a += cross;
    cx += (r[j] + r[i]) * cross;
    cy += (r[j + 1] + r[i + 1]) * cross;
  }
  if (Math.abs(a) < 1e-12) return [(minX + maxX) / 2, (minY + maxY) / 2];
  return [cx / (3 * a), cy / (3 * a)];
}

// 1-degree bbox buckets. ponytail: this is a flat grid, not an R-tree — a
// province is registered in every 1-degree cell its bounding box touches, so
// Russia's larger polygons are candidates for a few thousand buckets they only
// partly cover. Ceiling: candidate lists get long for sprawling provinces, which
// costs raycasts, not correctness. Upgrade path if the bake ever gets slow: swap
// the Map for a proper R-tree, or rasterise ring-by-ring with a scanline fill
// instead of testing cell centres one at a time.
function buildIndex(P) {
  const buckets = new Map();
  for (let p = 0; p < P.outer.length; p++) {
    const [minX, minY, maxX, maxY] = P.box[p];
    const x0 = Math.floor(minX) + 180;
    const x1 = Math.floor(maxX) + 180;
    const y0 = Math.floor(minY) + 90;
    const y1 = Math.floor(maxY) + 90;
    for (let y = Math.max(0, y0); y <= Math.min(179, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(359, x1); x++) {
        const key = y * 360 + x;
        let b = buckets.get(key);
        if (b === undefined) buckets.set(key, (b = []));
        b.push(p);
      }
    }
  }
  return buckets;
}

const bucketKey = (lon, lat) => {
  const x = Math.min(359, Math.max(0, Math.floor(lon) + 180));
  const y = Math.min(179, Math.max(0, Math.floor(lat) + 90));
  return y * 360 + x;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Reading rasters from ${IN_DIR}`);
const popc = readAsc(POPC, 'popc_1800AD.asc');

const { features, codes, P } = loadPolygons();
const nPolys = P.outer.length;
console.log(
  `  loaded ${fmt(features.length)} provinces -> ${fmt(nPolys)} polygons, ` +
    `${fmt(P.holes.reduce((s, h) => s + h.length, 0))} holes`,
);
const buckets = buildIndex(P);
console.log(`  bbox index: ${fmt(buckets.size)} occupied 1-degree buckets`);

// ---- 3. Assign every populated cell to a province by its centre point -------
//
// popc is a COUNT PER CELL, so summing cells is arithmetically exact: no area
// weighting, no cos(latitude) term. That is the whole reason for preferring
// popc over popd here.
//
// ponytail: a cell is credited whole to whichever province contains its centre.
// Ceiling: along a border, up to ~85 km2 of people land on one side of a line
// they straddle; the error is unbiased in aggregate and invisible at province
// scale, but a province whose entire population sits in a border cell can be
// off by a lot. Upgrade path: clip cells to polygons and weight by the
// intersected fraction (needs real polygon clipping, i.e. a GIS dependency).
const totals = new Float64Array(features.length);
const orphans = []; // [lon, lat, value] for cells matching no polygon
let rasterTotal = 0;
let populatedCells = 0;
let matchedCells = 0;
const t1 = Date.now();

for (let row = 0; row < NROWS; row++) {
  const lat = 90 - (row + 0.5) * CELL; // row 0 is the NORTH edge
  const rowOff = row * NCOLS;
  const by = Math.min(179, Math.max(0, Math.floor(lat) + 90)) * 360;
  for (let col = 0; col < NCOLS; col++) {
    const v = popc[rowOff + col];
    if (!(v > 0)) continue; // NaN (NODATA) and 0 both fall out here
    rasterTotal += v;
    populatedCells++;
    const lon = -180 + (col + 0.5) * CELL;
    const cand = buckets.get(by + Math.min(359, Math.max(0, Math.floor(lon) + 180)));
    let hit = -1;
    if (cand !== undefined) {
      for (let ci = 0; ci < cand.length; ci++) {
        const p = cand[ci];
        const b = P.box[p];
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
        if (!inRing(P.outer[p], lon, lat)) continue;
        const holes = P.holes[p];
        let inHole = false;
        for (let h = 0; h < holes.length; h++) {
          if (inRing(holes[h], lon, lat)) {
            inHole = true;
            break;
          }
        }
        // ponytail: first containing polygon wins. Natural Earth adm1 units are
        // meant to tile without overlap, so a second hit would be a defect in
        // the source geometry rather than a decision we need to arbitrate.
        if (!inHole) {
          hit = p;
          break;
        }
      }
    }
    if (hit >= 0) {
      totals[P.feature[hit]] += v;
      matchedCells++;
    } else {
      orphans.push(lon, lat, v);
    }
  }
}
const orphanCells = orphans.length / 3;
let orphanPeople = 0;
for (let i = 2; i < orphans.length; i += 3) orphanPeople += orphans[i];
console.log(`  cell assignment: ${((Date.now() - t1) / 1000).toFixed(1)}s`);

const zerosAfterCells = totals.reduce((s, v) => s + (v > 0 ? 0 : 1), 0);

// ---- 4. Orphan snap --------------------------------------------------------
//
// HYDE's land mask and Natural Earth's coastline disagree by a cell or two
// everywhere there is a coast, an estuary or a lagoon. The result is thousands
// of populated cells sitting just offshore of every polygon: Amsterdam, Venice,
// the Nile delta, the whole Norwegian and Chilean fjord coast. Dropping them
// silently loses over a percent of humanity, so each is pulled to the nearest
// province within 0.75 degrees.
//
// "Nearest" is measured to the polygon's BOUNDING BOX (the candidate point on
// the box clamped toward the cell), NOT to its centroid. This matters and was
// worth measuring: a cell sitting 3 arcmin off the Norwegian coast is 20 cells
// from any part of Norway's centre of mass, so a centroid metric abandons it,
// while its province's bbox is right there. The centroid variant is computed
// alongside and reported, because it silently loses ~3,900 cells / ~1.5M people
// and that fact should stay visible on every re-run rather than being folded
// into a comment.
//
// ponytail: distance to the bounding box, not to the ring itself. Ceiling: an
// L-shaped or diagonal-coastline province has a bbox that reaches into water it
// does not own, so an offshore cell can pick a large neighbour over the small
// island that genuinely owns it. Upgrade path: point-to-segment distance against
// every candidate ring, which is ~50x the work for a rounding error at province
// scale. Note also that a polygon's bbox necessarily contains its centroid, so
// bbox distance <= centroid distance: the same candidate list serves both
// metrics and no second index is needed.
//
// ponytail: the 9-bucket neighbourhood is CLAMPED at the antimeridian, not
// wrapped — bucketKey() pins lon-1 at -180 to bucket 0 instead of 359, so an
// orphan off eastern Chukotka cannot see a polygon at +179.9. Verified inert:
// 0 cells are lost, so nothing currently needs the wrap. (sampleDensity() DOES
// wrap, hence the asymmetry.) Related latent hazard: Antarctica ATA+00? has a
// full -180..180 bbox, so bbox distance makes it a candidate for ANY orphan
// within 0.75 deg of lat -63.2. Harmless only because HYDE 1800 puts nobody
// south of -60. Upgrade path for both: wrap the bucket lookup modulo 360 and
// measure distance to the ring rather than the box.
const SNAP_DEG = 0.75;
let snappedCells = 0;
let snappedPeople = 0;
let lostCells = 0;
let lostPeople = 0;
let centroidWouldLoseCells = 0;
let centroidWouldLosePeople = 0;
for (let i = 0; i < orphans.length; i += 3) {
  const lon = orphans[i];
  const lat = orphans[i + 1];
  const v = orphans[i + 2];
  let best = -1;
  let bestD2 = SNAP_DEG * SNAP_DEG;
  let bestCentroidD2 = SNAP_DEG * SNAP_DEG;
  // 0.75 deg can only reach into the 8 neighbouring 1-degree buckets, and a
  // polygon is registered in every bucket its bbox touches, so any polygon
  // within range is in one of these nine lists.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const b = buckets.get(bucketKey(lon + dx, lat + dy));
      if (b === undefined) continue;
      for (let ci = 0; ci < b.length; ci++) {
        const p = b[ci];
        const box = P.box[p];
        const qx = lon < box[0] ? box[0] : lon > box[2] ? box[2] : lon;
        const qy = lat < box[1] ? box[1] : lat > box[3] ? box[3] : lat;
        const d2 = (qx - lon) * (qx - lon) + (qy - lat) * (qy - lat);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
        const cd2 = (P.cx[p] - lon) * (P.cx[p] - lon) + (P.cy[p] - lat) * (P.cy[p] - lat);
        if (cd2 < bestCentroidD2) bestCentroidD2 = cd2;
      }
    }
  }
  if (bestCentroidD2 >= SNAP_DEG * SNAP_DEG) {
    centroidWouldLoseCells++;
    centroidWouldLosePeople += v;
  }
  if (best >= 0) {
    totals[P.feature[best]] += v;
    snappedCells++;
    snappedPeople += v;
  } else {
    lostCells++;
    lostPeople += v;
  }
}

const zerosAfterSnap = totals.reduce((s, v) => s + (v > 0 ? 0 : 1), 0);

// ---- 5. Sub-cell provinces -------------------------------------------------
//
// ~11% of provinces are smaller than one 5-arcmin cell (~85 km2 at the equator)
// and can therefore contain no cell centre at all: every Maltese local council,
// the Slovenian obcine, UK unitary authorities, Maldivian atolls, Gibraltar,
// Monaco, San Marino. For these, density is the right instrument — popd is
// people per km2, so popd at the province's location times the province's own
// spherical area reconstructs a count without needing the province to be big
// enough to swallow a sample point.
//
// ponytail: one density sample per polygon, taken at its centroid (or the
// nearest non-NODATA cell within 5 cells if the centroid lands on HYDE's water
// mask), assumed uniform across the polygon. Ceiling: a sub-cell province
// inherits its whole neighbourhood's average density, so a dense city core and
// its rural fringe inside the same source cell come out identical. Upgrade path:
// a finer raster (HYDE has no finer one for 1800) or a settlement-weighted
// downscale.
let popd = null;
let popdRescued = 0;
const stillZero = [];
for (let fi = 0; fi < features.length; fi++) {
  if (totals[fi] > 0) continue;
  if (popd === null) popd = readAsc(POPD, 'popd_1800AD.asc');
  let est = 0;
  for (let p = 0; p < nPolys; p++) {
    if (P.feature[p] !== fi) continue;
    const d = sampleDensity(popd, P.cx[p], P.cy[p]);
    if (d > 0) est += d * P.areaKm2[p];
  }
  if (est > 0) {
    totals[fi] = est;
    popdRescued++;
  }
}

// Nearest non-NODATA density sample, spiralling out by whole cells. 5 cells is
// ~25 arcmin, comfortably past any coastline mismatch; beyond that the sample
// would be describing somewhere else.
function sampleDensity(grid, lon, lat) {
  const col0 = Math.floor((lon + 180) / CELL);
  const row0 = Math.floor((90 - lat) / CELL);
  for (let r = 0; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        const row = row0 + dy;
        if (row < 0 || row >= NROWS) continue;
        const col = ((((col0 + dx) % NCOLS) + NCOLS) % NCOLS); // wrap the antimeridian
        const v = grid[row * NCOLS + col];
        if (v > 0) return v;
      }
    }
  }
  return 0;
}

// ---- 6. Round and write ----------------------------------------------------
//
// Integers only: fractional people are noise from a model that interpolates
// between census anchors, and rounding halves the file size. A province that is
// still 0 stays 0 — inventing a floor would be fabricating data, and the count
// is reported so it can be decided on deliberately.
const out = {};
let outTotal = 0;
let roundedToZero = 0;
for (let fi = 0; fi < features.length; fi++) {
  const v = Math.round(totals[fi]);
  out[codes[fi]] = v;
  outTotal += v;
  if (v === 0) {
    stillZero.push(codes[fi]);
    // Distinct failure mode worth its own count: the province did get an
    // estimate, it was just under half a person.
    if (totals[fi] > 0) roundedToZero++;
  }
}
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');

// ---- 7. Validation ---------------------------------------------------------

// popc_c.txt: one row per HYDE country region, one column per timestep. Two
// traps: the file ends with a literal `Total` row, so summing rows blindly
// double-counts everything; and the HYDE readme claims the values are "in 1000",
// which is wrong — they are absolute persons, as the Total row's agreement with
// the raster proves. Token 0 is the region id, token 1 is year -10000, so 1800
// (the 38th year listed) is token 38.
function readControl() {
  const lines = fs.readFileSync(POPC_C, 'utf-8').trim().split(/\r?\n/);
  let sum = 0;
  let rows = 0;
  let totalRow = null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t.length < 39) continue;
    const v = Number(t[38]);
    if (!Number.isFinite(v)) continue;
    if (t[0].toLowerCase() === 'total') {
      totalRow = v;
    } else {
      sum += v;
      rows++;
    }
  }
  const year = lines[0].trim().split(/\s+/)[38];
  return { sum, rows, totalRow, year };
}
const ctl = readControl();

const rollup = (key) => {
  const m = new Map();
  for (let fi = 0; fi < features.length; fi++) {
    const k = features[fi].properties[key];
    m.set(k, (m.get(k) || 0) + Math.round(totals[fi]));
  }
  return m;
};
const byOwner = rollup('owner');
const byCountry = rollup('modern_country');

const line = (label, got, exp, note = '') => {
  if (exp === undefined) return `  ${label.padEnd(30)} ${fmt(got).padStart(15)}  ${note}`;
  const d = ((got - exp) / exp) * 100;
  const flag = Math.abs(d) < 2 ? 'ok' : Math.abs(d) < 10 ? 'CHECK' : 'DISAGREES';
  return (
    `  ${label.padEnd(30)} ${fmt(got).padStart(15)}   expected ${fmt(exp).padStart(15)}   ` +
    `${(d >= 0 ? '+' : '') + d.toFixed(1)}%  ${flag}${note ? '  ' + note : ''}`
  );
};

console.log(`\nWrote ${OUT} (${fmt(fs.statSync(OUT).size)} bytes)\n`);
console.log('RASTER');
console.log(line('popc raster total', rasterTotal, EXPECT.rasterTotal));
console.log(line('populated cells', populatedCells));
console.log(`\nCONTROL FILE (popc_c.txt, column 38 = year ${ctl.year})`);
console.log(line(`sum of ${ctl.rows} country rows`, ctl.sum, EXPECT.controlTotal));
console.log(line('its own "Total" row', ctl.totalRow));
console.log(
  line('raster minus control', rasterTotal - ctl.sum, undefined, `(${pct(Math.abs(rasterTotal - ctl.sum), ctl.sum)}% of total)`),
);
console.log('\nCELL ASSIGNMENT');
console.log(line('cells inside a province', matchedCells, undefined, `(${pct(matchedCells, populatedCells)}%)`));
console.log(line('orphan cells (no polygon)', orphanCells, EXPECT.orphanCells));
console.log(line('orphan people', orphanPeople, EXPECT.orphanPeople, `(${pct(orphanPeople, rasterTotal)}% of world)`));
console.log(line('  ...snapped to a province', snappedCells, EXPECT.orphanCells, `= ${fmt(snappedPeople)} people`));
console.log(line('  ...LOST (nothing <0.75deg)', lostCells, undefined, `= ${fmt(lostPeople)} people`));
console.log(
  line('  [centroid metric would lose]', centroidWouldLoseCells, undefined, `= ${fmt(centroidWouldLosePeople)} people — why bbox distance is used`),
);
console.log('\nZERO PROVINCES');
console.log(line('zero after cell sum', zerosAfterCells, EXPECT.zerosNaive, `(${pct(zerosAfterCells, features.length)}% of 4,596)`));
console.log(line('zero after orphan snap', zerosAfterSnap));
console.log(line('rescued by popd x area', popdRescued, EXPECT.popdRescued, `(of the ${fmt(zerosAfterSnap)} left, not of ${fmt(zerosAfterCells)})`));
console.log(line('  ...of which round back to 0', roundedToZero, undefined, '(estimate was under half a person)'));
console.log(line('STILL ZERO in output', stillZero.length, undefined, '(left at 0, no floor invented)'));
if (stillZero.length > 0) {
  console.log(`    ${stillZero.slice(0, 20).join(' ')}${stillZero.length > 20 ? ' ...' : ''}`);
}
console.log('\nOUTPUT');
console.log(line('sum of written integers', outTotal, EXPECT.rasterTotal));
// The popd fallback ADDS people rather than moving them: a sub-cell province's
// inhabitants were already banked in whichever province swallowed the cell they
// sit in, so rescuing them double-counts by exactly this much. It is a fraction
// of a fraction of a percent, and the alternative — 285 provinces reading zero —
// is far worse on a map people hover over.
console.log(
  line('over/under vs raster', outTotal - rasterTotal, undefined, `(${pct(outTotal - rasterTotal, rasterTotal)}% — popd fallback double-counts sub-cell provinces)`),
);
console.log('\nSPOT CHECK');
console.log(line('GBR-2054 Leicestershire', out['GBR-2054'], EXPECT.leicestershire, '(1801 census: 130,081)'));
console.log('\nBY modern_country (what the sanity figures actually measure)');
for (const [k, exp] of Object.entries(EXPECT.countries)) {
  console.log(line(k, byCountry.get(k) || 0, exp));
}
console.log('\nBY owner (1680-era political control, colonies included)');
for (const k of ['France', 'Britain', 'Spain', 'China', 'Ottoman Empire', 'Russia']) {
  console.log(line(k, byOwner.get(k) || 0, undefined));
}
