import { useEffect, useMemo } from 'react';
import { useAppState } from '@/state/AppContext';
import styles from './NationsModal.module.css';

interface NationsModalProps {
  onDismiss: () => void;
}

interface NationRow {
  nation: string;
  armyStrength: number;
  armyCount: number;
  navyStrength: number;
  navyCount: number;
  /** Summed 1800 population of every province this nation currently owns. */
  population: number;
  /**
   * Provinces currently owned. Carried only so the population cell can tell
   * "owns no land at all" (nothing to sum — render an em dash, like the force
   * columns do for a nation with no armies) apart from "owns land the bake
   * scores at 0" (a measured figure — render 0). Mirrors how `armyCount`
   * decides the em dash for `armyStrength`.
   */
  provinceCount: number;
}

const emptyRow = (nation: string): NationRow => ({
  nation,
  armyStrength: 0,
  armyCount: 0,
  navyStrength: 0,
  navyCount: 0,
  population: 0,
  provinceCount: 0,
});

/**
 * Read-only overview of every nation in the country registry with its
 * aggregate force statistics, strongest army first. Nations without
 * forces sink to the bottom alphabetically. Each row also carries the
 * 1800 population of the provinces it holds, summed live off the map so
 * it tracks ownership repaints.
 */
export function NationsModal({ onDismiss }: NationsModalProps) {
  const { owners, forces, palette, provinces, provincesVersion } = useAppState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const rows = useMemo<NationRow[]>(() => {
    const byNation = new Map<string, NationRow>(
      owners.map((nation) => [nation, emptyRow(nation)]),
    );
    for (const f of forces) {
      let row = byNation.get(f.nation);
      if (!row) {
        row = emptyRow(f.nation);
        byNation.set(f.nation, row);
      }
      if (f.branch === 'army') {
        row.armyStrength += f.strength;
        row.armyCount += 1;
      } else {
        row.navyStrength += f.strength;
        row.navyCount += 1;
      }
    }
    // Population is joined off the province features instead of being carried
    // as its own state: `properties.owner` is normalized at BOOTSTRAP_DATA and
    // at SET_OWNER, and these row keys come from that same normalized registry,
    // so a direct === join is sound. `provinces` is null until bootstrap lands.
    for (const f of provinces?.features ?? []) {
      const { owner, population1800 } = f.properties;
      let row = byNation.get(owner);
      if (!row) {
        // Same guard the force loop above uses. Every province owner is in the
        // registry today, so this is unreachable in practice — but if one ever
        // drifted out, giving it a row keeps its people in the footer total
        // rather than silently dropping them.
        row = emptyRow(owner);
        byNation.set(owner, row);
      }
      // The bake can legitimately have no figure for an adm1_code, so treat a
      // missing value as 0 — one gap must not turn a nation's whole sum into
      // NaN. The province still counts as owned land.
      row.population += population1800 ?? 0;
      row.provinceCount += 1;
    }
    return [...byNation.values()].sort(
      (a, b) =>
        b.armyStrength - a.armyStrength ||
        b.navyStrength - a.navyStrength ||
        a.nation.localeCompare(b.nation),
    );
    // `provincesVersion` is load-bearing, not defensive. Province features are
    // mutated in place — SET_OWNER writes `f.properties.owner` directly and the
    // FeatureCollection reference never changes (see reducer.ts) — so a memo
    // keyed on `provinces` alone would compute once at bootstrap and then serve
    // stale populations forever after an admin repaints ownership, with no
    // visible error. The counter is the reducer's designated change signal for
    // exactly this; useCountryLabelsLayer depends on it the same way.
    //
    // ponytail: a full 4,596-feature rescan per ownership change, no index and
    // no cache. Ceiling is a couple of milliseconds on a modal that is only
    // mounted while someone is reading it, and any incremental tally would have
    // to be invalidated by this same counter anyway.
  }, [owners, forces, provinces, provincesVersion]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          troops: acc.troops + r.armyStrength,
          armies: acc.armies + r.armyCount,
          ships: acc.ships + r.navyStrength,
          navies: acc.navies + r.navyCount,
          population: acc.population + r.population,
        }),
        { troops: 0, armies: 0, ships: 0, navies: 0, population: 0 },
      ),
    [rows],
  );

  const num = (n: number, zero: boolean): string => (zero ? '—' : n.toLocaleString());

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onDismiss()}>
      <div className={styles.panel}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>Nations — Force Overview</h3>
          <button className={styles.close} onClick={onDismiss} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Nation</th>
                <th>Armies</th>
                <th>⚔ Troops</th>
                <th>Navies</th>
                <th>⚓ Ships</th>
                {/* Last on purpose: this is a force overview, so population
                    reads as context for the military figures, not as the
                    headline. */}
                <th>Population</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.nation}>
                  <td>
                    <span className={styles.nationCell}>
                      <span
                        className={styles.swatch}
                        style={{ background: palette[r.nation] ?? '#888' }}
                      />
                      <span className={styles.name}>{r.nation}</span>
                    </span>
                  </td>
                  <td className={r.armyCount === 0 ? styles.zero : styles.count}>
                    {num(r.armyCount, r.armyCount === 0)}
                  </td>
                  <td className={r.armyCount === 0 ? styles.zero : ''}>
                    {num(r.armyStrength, r.armyCount === 0)}
                  </td>
                  <td className={r.navyCount === 0 ? styles.zero : styles.count}>
                    {num(r.navyCount, r.navyCount === 0)}
                  </td>
                  <td className={r.navyCount === 0 ? styles.zero : ''}>
                    {num(r.navyStrength, r.navyCount === 0)}
                  </td>
                  {/* Em dash keyed on owning no provinces, NOT on a zero sum. A
                      nation that owns land the bake scores at 0 (maldives, as
                      of this data) is a real state we really did measure, so it
                      gets an honest "0"; only a nation with nothing to sum gets
                      the blank. */}
                  <td className={r.provinceCount === 0 ? styles.zero : ''}>
                    {num(r.population, r.provinceCount === 0)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total ({rows.length} nations)</td>
                <td>{totals.armies.toLocaleString()}</td>
                <td>{totals.troops.toLocaleString()}</td>
                <td>{totals.navies.toLocaleString()}</td>
                <td>{totals.ships.toLocaleString()}</td>
                <td>{totals.population.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className={styles.hint}>
          Sorted by army strength. Press Esc or click outside to close.
        </div>
      </div>
    </div>
  );
}
