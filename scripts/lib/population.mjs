// Population anchor rules — shared between the client reducer, the worker and
// the CI validator. Keep dependency-free (same constraint as movement.mjs) so
// the worker bundle stays small and CI needs no install step.
//
// One implementation on purpose: the recruitment gate is only as honest as
// the table it reads, and three consumers that each validated that table
// their own way would eventually accept and refuse different inputs.

const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

const isPop = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * Sum `population1800` by owning nation.
 *
 * `ownerships` is the exact full `[fid, owner][]` list of an imported world.
 * When supplied it — not `feature.properties.owner`, which is the CURRENT
 * world — decides who owns each province; fid is the index into
 * `provinces.features`. It must cover every province exactly once.
 *
 * Missing or malformed figures THROW. A province without a number is not a
 * province with zero people: summing it as 0 would silently floor a nation at
 * the minimum army and bake that into the anchor.
 *
 * @param {{ features: Array<{ properties: { owner?: string, population1800?: number } }> }} provinces
 * @param {Array<[number, string]>} [ownerships]
 * @returns {Record<string, number>}
 */
export function populationByOwner(provinces, ownerships) {
  const features = provinces?.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('province data is unavailable; cannot compute nation populations');
  }
  const n = features.length;

  /** @type {string[]} */
  const owners = new Array(n);
  if (ownerships === undefined) {
    for (let i = 0; i < n; i++) owners[i] = norm(features[i]?.properties?.owner);
  } else {
    if (!Array.isArray(ownerships)) {
      throw new Error('imported ownerships are not a list; cannot compute nation populations');
    }
    if (ownerships.length !== n) {
      throw new Error(
        `imported ownerships cover ${ownerships.length} provinces but the map has ${n}; cannot compute nation populations`,
      );
    }
    const seen = new Uint8Array(n);
    for (const entry of ownerships) {
      const fid = Array.isArray(entry) ? entry[0] : undefined;
      if (!Number.isInteger(fid) || fid < 0 || fid >= n) {
        throw new Error(
          `imported ownership has an invalid province id (${JSON.stringify(fid)}); cannot compute nation populations`,
        );
      }
      if (seen[fid]) {
        throw new Error(`imported ownership lists province ${fid} twice; cannot compute nation populations`);
      }
      seen[fid] = 1;
      owners[fid] = norm(entry[1]);
    }
  }

  const totals = new Map();
  for (let i = 0; i < n; i++) {
    const owner = owners[i];
    if (owner === '') {
      throw new Error(`province ${i} has no owner; cannot compute nation populations`);
    }
    const people = features[i]?.properties?.population1800;
    if (!isPop(people)) {
      throw new Error(
        `province ${i} has no valid population figure (${JSON.stringify(people) ?? 'missing'}); cannot compute nation populations`,
      );
    }
    const total = (totals.get(owner) ?? 0) + people;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`population of ${owner} overflows; cannot compute nation populations`);
    }
    totals.set(owner, total);
  }
  // fromEntries defines own properties, so a nation literally named
  // "__proto__" cannot reach the prototype.
  return Object.fromEntries([...totals].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/**
 * Why a turn.json population table cannot be trusted, or null when it can.
 *
 * A MISSING table returns a descriptive error too — whether absence is
 * permitted is the caller's decision (see resolvePopulation). Registry
 * nations missing from the table are fine: a nation created mid-turn has no
 * anchor until the next advance. Keys not in the registry are not: they are
 * stale (a removed or renamed country) or forged.
 *
 * @param {unknown} table
 * @param {Array<{ name: string }>} countries
 * @returns {string | null}
 */
export function populationTableError(table, countries) {
  if (table === undefined) return 'populationByNation is missing';
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    return 'populationByNation is not an object';
  }
  const proto = Object.getPrototypeOf(table);
  if (proto !== Object.prototype && proto !== null) return 'populationByNation is not a plain object';
  if (!Array.isArray(countries)) return 'the country registry is unavailable to check populationByNation against';
  const registry = new Set();
  for (const c of countries) registry.add(norm(c?.name));
  for (const key of Object.keys(table)) {
    if (key !== norm(key)) {
      return `populationByNation key ${JSON.stringify(key)} is not a normalized nation name`;
    }
    if (!registry.has(key)) {
      return `populationByNation lists ${JSON.stringify(key)}, which is not a country in the registry`;
    }
    if (!isPop(table[key])) {
      return `populationByNation[${JSON.stringify(key)}] is not a non-negative integer`;
    }
  }
  return null;
}

const ownershipSignature = (ownerships) =>
  Array.isArray(ownerships)
    ? JSON.stringify(
        ownerships
          .map((e) => (Array.isArray(e) ? [e[0], norm(e[1])] : null))
          .sort((a, b) => (a === null || b === null ? 0 : a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))),
      )
    : undefined;

const registrySignature = (countries) =>
  Array.isArray(countries) ? JSON.stringify(countries.map((c) => norm(c?.name)).sort()) : undefined;

function contextChanged(base, head) {
  const a = ownershipSignature(base?.state?.ownerships);
  const b = ownershipSignature(head?.state?.ownerships);
  if (a === undefined || a !== b) return true;
  const ra = registrySignature(base?.state?.countries);
  if (ra === undefined || ra !== registrySignature(head?.state?.countries)) return true;
  const bt = base?.turn;
  const ht = head?.turn;
  return (
    bt?.currentDate !== ht?.currentDate ||
    bt?.lastTurnDays !== ht?.lastTurnDays ||
    bt?.turnNumber !== ht?.turnNumber
  );
}

/**
 * The population table a submission is scored against, or why it cannot be.
 *
 * `base`/`head` are `{ state: { ownerships, countries }, turn: { currentDate,
 * lastTurnDays, turnNumber, populationByNation? } }`. The table is a turn-start
 * anchor, so omission is only safe while nothing it was derived from moved:
 *
 *   - head supplies a table: it must be valid; kept as-is (a mid-turn
 *     ownership change legitimately leaves it differing from live ownership).
 *   - head omits it, base had one, world/registry/clock unchanged: inherit.
 *   - head omits it, base had one, anything changed: error — the client
 *     dropped the anchor across an import, rename or advance.
 *   - neither has one: legacy, `undefined` (the flat pre-population cap).
 *
 * @param {{ state: object, turn: object }} base
 * @param {{ state: object, turn: object }} head
 * @returns {{ populationByNation: Record<string, number> | undefined, error: string | null }}
 */
export function resolvePopulation(base, head) {
  const fail = (error) => ({ populationByNation: undefined, error });
  const countries = head?.state?.countries;
  const supplied = head?.turn?.populationByNation;
  if (supplied !== undefined) {
    const error = populationTableError(supplied, countries);
    return error ? fail(error) : { populationByNation: supplied, error: null };
  }
  const inherited = base?.turn?.populationByNation;
  if (inherited === undefined) return { populationByNation: undefined, error: null };
  if (contextChanged(base, head)) {
    return fail(
      'populationByNation is missing although the world, country list or turn clock changed; ' +
        'rebuild the population anchor from the current ownership (hard-refresh and re-import) before submitting',
    );
  }
  const error = populationTableError(inherited, countries);
  return error ? fail(error) : { populationByNation: inherited, error: null };
}
