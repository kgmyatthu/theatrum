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
}

const emptyRow = (nation: string): NationRow => ({
  nation,
  armyStrength: 0,
  armyCount: 0,
  navyStrength: 0,
  navyCount: 0,
});

/**
 * Read-only overview of every nation in the country registry with its
 * aggregate force statistics, strongest army first. Nations without
 * forces sink to the bottom alphabetically.
 */
export function NationsModal({ onDismiss }: NationsModalProps) {
  const { owners, forces, palette } = useAppState();

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
    return [...byNation.values()].sort(
      (a, b) =>
        b.armyStrength - a.armyStrength ||
        b.navyStrength - a.navyStrength ||
        a.nation.localeCompare(b.nation),
    );
  }, [owners, forces]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          troops: acc.troops + r.armyStrength,
          armies: acc.armies + r.armyCount,
          ships: acc.ships + r.navyStrength,
          navies: acc.navies + r.navyCount,
        }),
        { troops: 0, armies: 0, ships: 0, navies: 0 },
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
