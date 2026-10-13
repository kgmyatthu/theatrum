import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { populationByOwner, populationTableError, resolvePopulation } from '../lib/population.mjs';
import { checkRaiseBudgets } from '../lib/movement.mjs';

// Exercise the actual reducer, including its TypeScript imports, without generated files.
const bundled = await build({
  stdin: {
    contents: 'export { reducer } from "./src/state/reducer.ts"; export { initialState } from "./src/state/state.ts";',
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { reducer, initialState } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function provinces() {
  return {
    type: 'FeatureCollection',
    features: [
      ['alpha', 1_000_000], ['beta', 2_000_000], ['alpha', 500_000],
    ].map(([owner, population1800], fid) => ({
      type: 'Feature',
      properties: { _fid: fid, adm1_code: `p${fid}`, owner, population1800 },
      geometry: { type: 'Polygon', coordinates: [] },
    })),
  };
}

function snapshot() {
  return {
    appVersion: 'theatrum/v10',
    ownerships: [[0, 'alpha'], [1, 'beta'], [2, 'alpha']],
    countries: [{ name: 'alpha', color: '#123456' }, { name: 'beta', color: '#654321' }],
    forces: [],
    currentDate: '1767-05-01',
    lastTurnDays: 30,
    turnNumber: 73,
    populationByNation: { alpha: 1_500_000, beta: 2_000_000 },
  };
}

function state() {
  return reducer(structuredClone(initialState), {
    type: 'BOOTSTRAP_DATA',
    payload: { provinces: provinces(), cities: [], snapshot: snapshot() },
  });
}

function world(snap = snapshot()) {
  const { ownerships, countries, ...turn } = snap;
  return { state: { ownerships, countries }, turn };
}

test('population aggregation conserves people while moving a province to its new owner', () => {
  const map = provinces();
  assert.deepEqual(populationByOwner(map), { alpha: 1_500_000, beta: 2_000_000 });
  const redistributed = populationByOwner(map, [[0, ' BETA '], [1, 'beta'], [2, 'alpha']]);
  assert.deepEqual(redistributed, { alpha: 500_000, beta: 3_000_000 });
  assert.equal(map.features[0].properties.owner, 'alpha');
});

test('a rebuild rejects incomplete or ambiguous ownership rather than inventing population', () => {
  const map = provinces();
  for (const ownerships of [
    [[0, 'alpha'], [1, 'beta']],
    [[0, 'alpha'], [0, 'beta'], [2, 'alpha']],
    [[0, 'alpha'], [1, 'beta'], [3, 'alpha']],
  ]) {
    assert.throws(() => populationByOwner(map, ownerships));
  }
});

test('missing, partial, or invalid population data cannot establish a new baseline', () => {
  for (const population1800 of [undefined, null, NaN, Infinity, -1, 1.5]) {
    const map = provinces();
    map.features[1].properties.population1800 = population1800;
    assert.throws(() => populationByOwner(map));
  }
  assert.throws(() => populationByOwner({ features: [] }));
  const zero = provinces();
  for (const f of zero.features) f.properties.population1800 = 0;
  assert.deepEqual(populationByOwner(zero), { alpha: 0, beta: 0 });
});

test('prototype-like country names are counted as ordinary own population keys', () => {
  const actual = populationByOwner(provinces(), [[0, '__proto__'], [1, 'constructor'], [2, '__proto__']]);
  assert.equal(Object.hasOwn(actual, '__proto__'), true);
  assert.equal(actual.__proto__, 1_500_000);
  assert.equal(actual.constructor, 2_000_000);
  assert.equal(populationTableError(actual, [{ name: '__proto__' }, { name: 'constructor' }]), null);
  const refusal = checkRaiseBudgets({ constructor: [{ branch: 'army', strength: 3001, turnStartStrength: 0, turnStartBranch: 'army' }] }, 30, {});
  assert.match(refusal, /standing army ceiling/);
});

test('territory gains and newly created countries wait until the next turn', () => {
  const old = state();
  const added = reducer(old, { type: 'ADD_COUNTRY', payload: { name: 'gamma', color: '#abcdef' } });
  const transferred = reducer(added, { type: 'SET_OWNER', payload: { fids: [0], owner: 'gamma' } });
  assert.deepEqual(transferred.populationByNation, { alpha: 1_500_000, beta: 2_000_000 });
  assert.deepEqual(populationByOwner(transferred.provinces), { alpha: 500_000, beta: 2_000_000, gamma: 1_000_000 });
  const advanced = reducer(transferred, { type: 'ADVANCE_TURN', payload: { newDate: '1767-06-01' } });
  assert.equal(advanced.turnNumber, 74);
  assert.equal(advanced.currentDate, '1767-06-01');
  assert.deepEqual(advanced.populationByNation, { alpha: 500_000, beta: 2_000_000, gamma: 1_000_000 });
});

test('renaming preserves the frozen population, not the current territory total', () => {
  const transferred = reducer(state(), { type: 'SET_OWNER', payload: { fids: [0], owner: 'beta' } });
  const renamed = reducer(transferred, { type: 'RENAME_COUNTRY', payload: { oldName: 'alpha', newName: 'Gamma' } });
  assert.deepEqual(renamed.populationByNation, { beta: 2_000_000, gamma: 1_500_000 });
  assert.deepEqual(populationByOwner(renamed.provinces), { beta: 3_000_000, gamma: 500_000 });
});

test('a failed turn advance leaves the clock, forces, and anchor untouched', () => {
  const old = state();
  delete old.provinces.features[1].properties.population1800;
  const before = structuredClone(old);
  const next = reducer(old, { type: 'ADVANCE_TURN', payload: { newDate: '1767-06-01' } });
  assert.deepEqual(next, before);
});

test('import preserves a valid mid-turn anchor through an export-shaped JSON round trip', () => {
  const imported = JSON.parse(JSON.stringify(snapshot()));
  imported.ownerships[0][1] = 'beta';
  const next = reducer(state(), { type: 'IMPORT_SNAPSHOT', payload: { snapshot: imported, rebuildPopulation: false } });
  assert.equal(next.provinces.features[0].properties.owner, 'beta');
  assert.deepEqual(next.populationByNation, { alpha: 1_500_000, beta: 2_000_000 });
  assert.deepEqual(populationByOwner(next.provinces), { alpha: 500_000, beta: 3_000_000 });
});

test('explicit legacy restore rebuilds from imported ownership without advancing its clock', () => {
  const imported = snapshot();
  delete imported.populationByNation;
  imported.ownerships = [[0, 'gamma'], [1, 'gamma'], [2, 'gamma']];
  imported.countries = [{ name: 'gamma', color: '#abcdef' }];
  const next = reducer(state(), { type: 'IMPORT_SNAPSHOT', payload: { snapshot: imported, rebuildPopulation: true } });
  assert.deepEqual(next.populationByNation, { gamma: 3_500_000 });
  assert.equal(next.currentDate, imported.currentDate);
  assert.equal(next.turnNumber, imported.turnNumber);
  assert.deepEqual(next.owners, ['gamma']);
});

test('invalid imports and missing-data rebuilds cannot partially mutate the current world', () => {
  for (const kind of ['missing-table', 'missing-population', 'duplicate-fid', 'unknown-owner', 'stale-key']) {
    const old = state();
    const imported = snapshot();
    imported.ownerships[0][1] = 'beta';
    let rebuildPopulation = false;
    if (kind === 'missing-table') delete imported.populationByNation;
    if (kind === 'missing-population') {
      delete old.provinces.features[1].properties.population1800;
      rebuildPopulation = true;
    }
    if (kind === 'duplicate-fid') imported.ownerships[1][0] = 0;
    if (kind === 'unknown-owner') imported.ownerships[1][1] = 'removed nation';
    if (kind === 'stale-key') imported.populationByNation['removed nation'] = 200;
    const before = structuredClone(old);
    const next = reducer(old, { type: 'IMPORT_SNAPSHOT', payload: { snapshot: imported, rebuildPopulation } });
    assert.deepEqual(next, before, kind);
    assert.deepEqual(old, before, `${kind}: input state mutated`);
  }
});

test('ordinary remote refresh does not silently rebuild a frozen or absent anchor', () => {
  const imported = snapshot();
  imported.ownerships[0][1] = 'beta';
  const next = reducer(state(), { type: 'APPLY_SNAPSHOT', payload: { snapshot: imported } });
  assert.deepEqual(next.populationByNation, { alpha: 1_500_000, beta: 2_000_000 });
  delete imported.populationByNation;
  const legacy = reducer(state(), { type: 'APPLY_SNAPSHOT', payload: { snapshot: imported } });
  assert.equal(legacy.populationByNation, undefined);
});

test('submission cannot inherit an anchor across ownership, identity, or clock changes', () => {
  for (const change of [
    h => { h.state.ownerships[0][1] = 'beta'; },
    h => { h.state.countries.push({ name: 'gamma', color: '#abcdef' }); },
    h => { h.turn.turnNumber++; },
    h => { h.turn.currentDate = '1767-06-01'; },
    h => { h.turn.lastTurnDays = 60; },
  ]) {
    const base = world();
    const head = structuredClone(base);
    delete head.turn.populationByNation;
    change(head);
    assert.ok(resolvePopulation(base, head).error);
  }
});

test('ownership-neutral legacy clients inherit safely and genuinely pre-feature games stay unenforced', () => {
  const base = world();
  const head = structuredClone(base);
  delete head.turn.populationByNation;
  head.state.ownerships.reverse();
  head.state.countries.reverse();
  head.state.countries[0].color = '#ffffff';
  assert.deepEqual(resolvePopulation(base, head), { populationByNation: base.turn.populationByNation, error: null });
  delete base.turn.populationByNation;
  head.turn.turnNumber++;
  assert.deepEqual(resolvePopulation(base, head), { populationByNation: undefined, error: null });
});

test('valid mid-turn differences are accepted but removed-country population keys are rejected', () => {
  const base = world();
  const head = structuredClone(base);
  head.state.ownerships[0][1] = 'beta';
  assert.equal(resolvePopulation(base, head).error, null);
  head.turn.populationByNation['old world'] = 900_000;
  assert.ok(resolvePopulation(base, head).error);
});

test('published population anchors name current countries and conserve the measured world population', () => {
  const load = name => JSON.parse(readFileSync(new URL(`../../public/data/${name}`, import.meta.url), 'utf8'));
  const published = load('turn.json').populationByNation;
  const registry = load('state.json');
  const map = load('provinces.geojson');
  const measured = load('population1800.json');
  assert.equal(populationTableError(published, registry.countries), null);
  const fids = registry.ownerships.map(([fid]) => fid);
  assert.equal(new Set(fids).size, map.features.length);
  assert.ok(fids.every(fid => Number.isInteger(fid) && fid >= 0 && fid < map.features.length));
  const known = new Set(registry.countries.map(c => c.name));
  assert.ok(registry.ownerships.every(([, owner]) => known.has(owner)));
  let measuredTotal = 0;
  for (const feature of map.features) {
    const people = measured[feature.properties.adm1_code];
    assert.ok(Number.isSafeInteger(people) && people >= 0);
    measuredTotal += people;
  }
  // Equality per country would incorrectly reject legitimate mid-turn transfers.
  assert.equal(Object.values(published).reduce((sum, people) => sum + people, 0), measuredTotal);
});
