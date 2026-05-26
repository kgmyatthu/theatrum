import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { haversineKm, formatDistance } from '@/utils/geometry';
import { budgetForBranch } from '@/utils/movement';
import { useAppState } from '@/state/AppContext';
import type { PendingMove } from '@/hooks/useForcesLayer';
import styles from './MobilizationConfirm.module.css';

interface MobilizationConfirmProps {
  pending: PendingMove;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MobilizationConfirm({ pending, onConfirm, onCancel }: MobilizationConfirmProps) {
  const { force, origin, target } = pending;
  const { lastTurnDays } = useAppState();
  const km = haversineKm(origin.lat, origin.lon, target.lat, target.lon);

  // Budget math — uses the force's current kmMovedThisTurn (already-spent
  // budget) plus this drag's straight-line distance. Matches the worker's
  // server-side check, so an in-UI green light means the submission won't
  // be rejected for movement.
  const budget = budgetForBranch(force.branch, lastTurnDays);
  const spent = force.kmMovedThisTurn;
  const projected = spent + km;
  const overBudget = projected > budget;

  // Esc cancels, Enter confirms (only when not over budget).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && !overBudget) onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm, overBudget]);

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={styles.panel}>
        <h3 className={styles.title}>Confirm {force.branch === 'navy' ? 'Naval' : 'Army'} Mobilization</h3>

        <div className={styles.row}>
          <span className={styles.key}>Unit</span>
          <span className={styles.value}>{force.name}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>Nation</span>
          <span className={styles.value}>{force.nation}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>From</span>
          <span className={styles.value}>
            {origin.lat.toFixed(2)}, {origin.lon.toFixed(2)}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.key}>To</span>
          <span className={styles.value}>
            {target.lat.toFixed(2)}, {target.lon.toFixed(2)}
          </span>
        </div>

        <div className={styles.distance}>March: {formatDistance(km)}</div>

        <div
          className={styles.distance}
          style={{
            color: overBudget ? 'var(--text-danger, #ff6b6b)' : 'var(--text-muted)',
            background: 'var(--bg-panel)',
            fontWeight: 500,
            fontSize: 12,
            marginTop: 6,
          }}
        >
          Budget this turn: {Math.round(spent)} / {budget} km
          <br />
          After this move: {Math.round(projected)} / {budget} km
          {overBudget && (
            <>
              <br />
              <span style={{ fontWeight: 700 }}>Over budget — cannot confirm.</span>
            </>
          )}
        </div>

        <div className={styles.buttons}>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="success" disabled={overBudget} onClick={onConfirm}>
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
