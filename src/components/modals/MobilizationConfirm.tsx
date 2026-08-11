import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { haversineKm, formatDistance } from '@/utils/geometry';
import { effectiveBudget, isNewlyRaised } from '@/utils/movement';
import { useAppState } from '@/state/AppContext';
import type { PendingMove } from '@/hooks/useForcesLayer';
import styles from './MobilizationConfirm.module.css';

interface MobilizationConfirmProps {
  pending: PendingMove;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MobilizationConfirm({ pending, onConfirm, onCancel }: MobilizationConfirmProps) {
  const { force, origin, target, mergeTarget } = pending;
  const { lastTurnDays, turnNumber } = useAppState();
  const km = haversineKm(origin.lat, origin.lon, target.lat, target.lon);

  // Budget math — the whole turn's budget against this one march, because
  // a force marches once per turn and only an unmarched force is draggable
  // at all. Matches both servers, so a green light here means the
  // submission won't be rejected for movement. effectiveBudget returns 0
  // for forces raised this turn — they can't move until next turn.
  const justRaised = isNewlyRaised(force, turnNumber);
  const budget = effectiveBudget(force, lastTurnDays, turnNumber);
  const overBudget = km > budget;

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
        <h3 className={styles.title}>
          {mergeTarget
            ? `Confirm ${force.branch === 'navy' ? 'Fleet' : 'Army'} Merge`
            : `Confirm ${force.branch === 'navy' ? 'Naval' : 'Army'} Mobilization`}
        </h3>

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
            {mergeTarget
              ? mergeTarget.name
              : `${target.lat.toFixed(2)}, ${target.lon.toFixed(2)}`}
          </span>
        </div>
        {mergeTarget && (
          <div className={styles.row}>
            <span className={styles.key}>Merged</span>
            <span className={styles.value}>
              {force.strength + mergeTarget.strength}{' '}
              {force.branch === 'navy' ? 'ships' : 'men'}
            </span>
          </div>
        )}

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
          {justRaised ? (
            <>
              Newly raised this turn — <b>cannot move until next turn.</b>
            </>
          ) : (
            <>
              This turn&rsquo;s march: {Math.round(km)} / {budget} km
              <br />
              {mergeTarget
                ? 'The merged force keeps the longer of the two marches — and marches no further this turn.'
                : 'A force marches once per turn.'}
              {overBudget && (
                <>
                  <br />
                  <span style={{ fontWeight: 700 }}>Over budget — cannot confirm.</span>
                </>
              )}
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
